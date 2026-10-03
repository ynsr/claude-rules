/**
 * DSH (DeepSeek Harness) Cordis plugin for path-scoped `.dsh/rules/*.md` and
 * `.claude/rules/*.md` rule injection.
 *
 * Discovers rules with `paths` frontmatter, tracks which files the session
 * touches via `tools/result`, and injects matching rules as `<system-reminder>`
 * user-role messages through the agent inbox — mid-session, progressive disclosure,
 * matching the same semantics as Claude Code's `.claude/rules/*.md` support.
 *
 * Dependencies: @deepseek-ai/dsh-llm (createUserMessage), @deepseek-ai/cordis (ctx).
 * Core rule logic is imported from the dependency-free sibling modules.
 */

import type { Context } from "@deepseek-ai/cordis";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname, relative, sep } from "node:path";
import { discoverAgents, matchAgent } from "../agents.ts";
import type { AgentDoc } from "../agents.ts";
import { findRepoRoot } from "../discover.ts";
import { parseRule } from "../rule.ts";
import type { Rule } from "../rule.ts";
import { matchRule, normalizePath } from "../match.ts";
import { formatRules } from "../format.ts";

// ── Constants ───────────────────────────────────────────────────────────────

/** Tools whose arguments carry a `file_path` field. Matches DSH's tool naming. */
const FILE_TOUCH_TOOLS: Record<string, boolean> = { read: true, write: true, edit: true };

// ── Logger ──────────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

class Logger {
  private levelNum: number;
  private logPath: string;

  constructor(level: LogLevel, logPath: string) {
    this.levelNum = LOG_LEVELS[level];
    this.logPath = logPath;
    // Ensure the log directory exists.
    const dir = dirname(this.logPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    // Stamp the file header on first open.
    if (!existsSync(this.logPath)) {
      writeFileSync(this.logPath, `[dsh-rules] log started at ${new Date().toISOString()}\n`, "utf8");
    }
  }

  private write(level: LogLevel, message: string) {
    if (LOG_LEVELS[level] < this.levelNum) return;
    try {
      appendFileSync(this.logPath, `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}\n`, "utf8");
    } catch {
      // last resort: nothing we can do
    }
  }

  debug(message: string) { this.write("debug", message); }
  info(message: string) { this.write("info", message); }
  warn(message: string) { this.write("warn", message); }
  error(message: string) { this.write("error", message); }
}

// ── Discovery ───────────────────────────────────────────────────────────────

/**
 * Collect rule files from a single rules directory (e.g. `<dir>/.dsh/rules/`).
 * Uses the same mtime-keyed cache as the omp discover module.
 */
const fileCache = new Map<string, { mtimeMs: number; rule: Rule }>();

function collectRules(rulesDir: string, log: Logger): Rule[] {
  const out: Rule[] = [];
  if (!existsSync(rulesDir)) {
    log.debug(`collectRules: directory does not exist, skipping: ${rulesDir}`);
    return out;
  }
  const entries = readdirSync(rulesDir, { withFileTypes: true });
  log.debug(`collectRules: scanning ${rulesDir} — ${entries.length} entries`);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(rulesDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRules(full, log));
    } else if (/\.(md|mdc)$/i.test(entry.name)) {
      try {
        const st = statSync(full);
        const cached = fileCache.get(full);
        let rule: Rule;
        if (cached && cached.mtimeMs === st.mtimeMs) {
          rule = cached.rule;
          log.debug(`collectRules: cache hit: ${full}`);
        } else {
          // relPath is the path relative to the rules root for display
          const rel = relative(rulesDir, full).split(sep).join("/");
          rule = parseRule(full, rel, readFileSync(full, "utf8"), st.mtimeMs);
          fileCache.set(full, { mtimeMs: st.mtimeMs, rule });
          log.debug(`collectRules: parsed: ${full} (name="${rule.name}", paths=${JSON.stringify(rule.paths)}, alwaysApply=${rule.alwaysApply})`);
        }
        out.push(rule);
      } catch (err) {
        log.warn(`collectRules: skipping unreadable file: ${full} — ${String(err)}`);
      }
    }
  }
  return out;
}

/**
 * Walk from cwd to repo root, discovering rules in each `.dsh/rules/` and
 * `.claude/rules/` directory, then user-global `~/.dsh/rules/`.
 */
export function discoverDshRules(cwd: string, log: Logger): Rule[] {
  const root = findRepoRoot(cwd);
  log.info(`discoverDshRules: cwd=${cwd}, repoRoot=${root}`);
  const rules: Rule[] = [];

  // Walk from cwd (inclusive) to repo root, collecting each depth's rules.
  let dir = resolve(cwd);
  const walk: string[] = [];
  for (;;) {
    walk.push(dir);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  log.debug(`discoverDshRules: walk path: ${walk.join(" → ")}`);
  // walk is cwd → root; reverse so ancestors come first, nearer last.
  for (const d of walk.reverse()) {
    for (const rd of RULE_DIRS) {
      const rulesDir = join(d, rd, "rules");
      rules.push(...collectRules(rulesDir, log));
    }
  }

  // User-global scope (~/.dsh/rules/ and ~/.claude/rules/).
  for (const rd of RULE_DIRS) {
    const rulesDir = join(homedir(), rd, "rules");
    rules.push(...collectRules(rulesDir, log));
  }

  log.info(`discoverDshRules: ${rules.length} raw rules before dedup`);

  // Dedup by absolute path, keep first occurrence. Duplicate filenames across
  // scopes: a later (more-local / user) entry wins, so remove earlier same-name.
  const seen = new Set<string>();
  const deduped: Rule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.file)) continue;
    seen.add(rule.file);
    const idx = deduped.findIndex((r) => r.name === rule.name);
    if (idx !== -1) {
      log.debug(`discoverDshRules: dedup — "${rule.name}" from ${deduped[idx].file} superseded by ${rule.file}`);
      deduped.splice(idx, 1);
    }
    deduped.push(rule);
  }
  log.info(`discoverDshRules: ${deduped.length} rules after dedup`);
  for (const r of deduped) {
    log.debug(`discoverDshRules: rule="${r.name}" file="${r.file}" alwaysApply=${r.alwaysApply} paths=${JSON.stringify(r.paths)}`);
  }
  return deduped;
}

/** Clear the mtime-keyed rule cache (useful for testing). */
export function clearDshRuleCache(): void {
  fileCache.clear();
}

// ── Formatting ──────────────────────────────────────────────────────────────

/**
 * Format matched rules as a DSH `<system-reminder>` block, matching the same
 * wrapping style used by the `agent-instructions` plugin.
 */
export function formatDshRules(rules: Rule[]): string {
  if (rules.length === 0) return "";
  const body = formatRules(rules).trimEnd();
  return `<system-reminder>\nPath-scoped rules matched by files the session touched:\n\n${body}\n</system-reminder>`;
}

// ── Plugin ──────────────────────────────────────────────────────────────────

export interface DshRulesConfig {
  /**
   * Maximum UTF-8 bytes for the injected rule block. Defaults to 65536 to match
   * the default `agent-instructions` budget.
   */
  maxBytes?: number;
  /**
   * Log level: "debug" | "info" | "warn" | "error". Default: "info".
   */
  logLevel?: LogLevel;
  /**
   * Absolute path to the log file. Default: /tmp/dsh-rules.log
   */
  logPath?: string;
}

/**
 * Cordis plugin factory for path-scoped rule injection.
 *
 * Usage (cordis.yml):
 *   - id: dsh-rules
 *     name: '/path/to/claude-rules-for-omp/src/dsh/plugin.ts'
 *     config:
 *       maxBytes: 65536
 *       logLevel: debug
 *       logPath: /tmp/dsh-rules.log
 */
export function apply(ctx: Context, config: DshRulesConfig = {}): void {
  const log = new Logger(config.logLevel ?? "info", config.logPath ?? "/tmp/dsh-rules.log");
  const maxBytes = config.maxBytes ?? 65536;

  log.info("=== Plugin apply() called ===");
  log.info(`config: maxBytes=${maxBytes}, logLevel=${config.logLevel ?? "info"}, logPath=${config.logPath ?? "/tmp/dsh-rules.log"}`);

  let rules: Rule[] = [];
  let agents: AgentDoc[] = [];
  let repoRoot = "";
  let sessionCwd = "";
  const touched = new Set<string>();
  const formattedCache = new Map<string, string>();
  // Per-agent session state: inject-once keys + token sizes for compaction.
  const sessionState = new Map<string, { injectedEver: Set<string>; prevTokens: number }>();

  function getSessionState(sessionId: string) {
    let state = sessionState.get(sessionId);
    if (!state) {
      state = { injectedEver: new Set(), prevTokens: 0 };
      sessionState.set(sessionId, state);
      log.debug(`getSessionState: created new state for session ${sessionId}`);
    }
    return state;
  }

  function itemKey(file: string, mtimeMs: number): string {
    return `${file}@${mtimeMs}`;
  }

  function estimateTokensLocal(content: unknown): number {
    if (typeof content === "string") return Math.ceil(content.length / 4);
    if (Array.isArray(content)) {
      let chars = 0;
      for (const c of content) {
        if (c !== null && typeof c === "object" && "type" in c && (c as { type?: unknown }).type === "text" && "text" in c) {
          const t = (c as { text?: unknown }).text;
          if (typeof t === "string") chars += t.length;
        }
      }
      return Math.ceil(chars / 4);
    }
    return 0;
  }

  // ── discover rules on the first file touch ──

  let discovered = false;

  function ensureDiscovered(cwd: string) {
    if (discovered) {
      log.debug("ensureDiscovered: already discovered, skipping");
      return;
    }
    discovered = true;
    repoRoot = findRepoRoot(cwd);
    sessionCwd = cwd;
    log.info(`ensureDiscovered: repoRoot=${repoRoot}, sessionCwd=${cwd}`);
    rules = discoverDshRules(cwd, log);
    agents = discoverAgents(cwd);
    log.info(`ensureDiscovered: ${rules.length} rules + ${agents.length} AGENTS.md loaded`);
  }

  function rediscoverOnCompaction() {
    clearDshRuleCache();
    rules = discoverDshRules(sessionCwd, log);
    agents = discoverAgents(sessionCwd);
    formattedCache.clear();
    for (const state of sessionState.values()) state.injectedEver.clear();
    log.info(`compaction: re-discovered ${rules.length} rules + ${agents.length} AGENTS.md, cleared inject-once state`);
  }

  // Clear nothing per turn: injection is once-per-session. `step/start` only
  // ensures per-session state exists for the compaction detector.
  log.info("Registering session/event handler…");
  const disposer1 = ctx.on("session/event", (...args: unknown[]) => {
    const session = args[0] as { id: string } | undefined;
    const event = args[1] as { type: string } | undefined;
    if (!session || !event) {
      log.debug(`session/event: skipped — no session or event (session=${typeof session}, event=${typeof event})`);
      return;
    }
    log.debug(`session/event: session=${session.id}, event.type=${event.type}`);
    if (event.type === "step/start") {
      getSessionState(session.id);
      log.debug(`session/event: ensured state for session ${session.id}`);
    }
    // Explicit compaction signal from the harness, when present. DSH core
    // (`dsh-compaction` / `dsh-hook-protocol`) pairs hooks rather than
    // emitting cordis `session/event` types, and the invariant package names
    // no canonical event string — so match defensively on any signal whose
    // type mentions compact/summarize/prune.
    if (/compact|summar|prune/i.test(event.type)) {
      log.info(`session/event: compaction signal ${event.type} for session ${session.id}`);
      rediscoverOnCompaction();
    }
  });
  log.info(`session/event handler registered, disposer=${typeof disposer1}`);

  // ── listen for tool results ──

  log.info("Registering tools/result handler…");
  const disposer2 = ctx.on("tools/result", (...args: unknown[]) => {
    const exec = args[0] as {
      name: string; arguments: Record<string, unknown>;
      agent?: { session: { id: string; header?: { cwd?: string } }; inbox: { prepend: (target: string, msg: unknown) => void } };
    } | undefined;
    const result = args[1] as { isError: boolean } | undefined;
    if (!exec || !result) {
      log.debug(`tools/result: skipped — no exec or result (exec=${typeof exec}, result=${typeof result})`);
      return;
    }

    log.debug(`tools/result: name=${exec.name}, isError=${result.isError}, hasAgent=${!!exec.agent}`);

    // Only process successful file-touch tools
    if (result.isError) {
      log.debug(`tools/result: skipped — error result`);
      return;
    }
    if (!FILE_TOUCH_TOOLS[exec.name]) {
      log.debug(`tools/result: skipped — not a file-touch tool (${exec.name})`);
      return;
    }
    const filePath = exec.arguments.file_path;
    if (typeof filePath !== "string" || filePath.trim() === "") {
      log.debug(`tools/result: skipped — no file_path argument (got ${typeof filePath})`);
      return;
    }

    if (exec.agent) {
      log.info(`tools/result: processing file_path="${filePath}" for session ${exec.agent.session.id}`);

      const cwd = exec.agent.session.header?.cwd ?? process.cwd();
      log.debug(`tools/result: session cwd="${cwd}"`);
      ensureDiscovered(cwd);

      const norm = normalizePath(filePath.trim(), repoRoot);
      touched.add(norm);
      log.debug(`tools/result: normalized path="${norm}", touched.size=${touched.size}`);

      const sessionId = exec.agent.session.id;
      const state = getSessionState(sessionId);

      // Compaction heuristic: estimate conversation size from the touched
      // history window is unavailable here, so track cumulative touched-path
      // chars as a monotonic proxy is wrong — instead rely on explicit
      // compaction events above. Growth alone never clears inject-once state.

      // Match rules + nested AGENTS.md against all touched paths
      const touchedList = [...touched];
      const matchedRules = rules.filter((r) => !state.injectedEver.has(itemKey(r.file, r.mtimeMs)) && matchRule(r, touchedList));
      const matchedAgents = agents.filter((a) => !state.injectedEver.has(itemKey(a.file, a.mtimeMs)) && matchAgent(a, touchedList, repoRoot));
      log.info(`tools/result: ${matchedRules.length} fresh rules + ${matchedAgents.length} fresh AGENTS.md out of ${rules.length} rules`);
      if (matchedRules.length === 0 && matchedAgents.length === 0) {
        log.debug("tools/result: nothing fresh, returning");
        return;
      }

      // Mark as injected this session (inject-once; growth never re-injects)
      for (const r of matchedRules) state.injectedEver.add(itemKey(r.file, r.mtimeMs));
      for (const a of matchedAgents) state.injectedEver.add(itemKey(a.file, a.mtimeMs));

      // Format: ancestors first, leaf last; rules after AGENTS.md.
      const sections: string[] = [];
      for (const a of matchedAgents) {
        const key = itemKey(a.file, a.mtimeMs);
        let body = formattedCache.get(key);
        if (body === undefined) {
          body = `Contents of ${a.file}:\n\n${a.body.trim()}\n`;
          formattedCache.set(key, body);
        }
        sections.push(body);
      }
      if (matchedRules.length > 0) {
        const key = `rules@${matchedRules.map((r) => itemKey(r.file, r.mtimeMs)).join("+")}`;
        let body = formattedCache.get(key);
        if (body === undefined) {
          body = formatRules(matchedRules);
          formattedCache.set(key, body);
        }
        sections.push(body);
      }
      let text = `<system-reminder>\nPath-scoped rules matched by files the session touched:\n\n${sections.join("\n---\n\n").trimEnd()}\n</system-reminder>`;
      void estimateTokensLocal;
      log.debug(`tools/result: formatted text length=${Buffer.byteLength(text, "utf8")} bytes, maxBytes=${maxBytes}`);

      // Guard against the byte budget — truncate by dropping rules if needed
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        log.warn(`tools/result: formatted text exceeds maxBytes (${Buffer.byteLength(text, "utf8")} > ${maxBytes}), truncating`);
        let remaining = matchedRules;
        while (remaining.length > 0 && Buffer.byteLength(formatDshRules(remaining), "utf8") > maxBytes) {
          remaining = remaining.slice(0, -1);
        }
        if (remaining.length === 0 && matchedAgents.length === 0) {
          log.warn("tools/result: all rules dropped after truncation, nothing to inject");
          return;
        }
        const kept: string[] = [];
        for (const a of matchedAgents) kept.push(`Contents of ${a.file}:\n\n${a.body.trim()}\n`);
        if (remaining.length > 0) kept.push(formatRules(remaining));
        text = `<system-reminder>\nPath-scoped rules matched by files the session touched:\n\n${kept.join("\n---\n\n").trimEnd()}\n</system-reminder>`;
        log.info(`tools/result: truncated to ${remaining.length} rules (${Buffer.byteLength(text, "utf8")} bytes)`);
      }

      try {
        exec.agent.inbox.prepend("next-step", createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "path-scoped-rules", form: "instructions" },
        }));
        log.info(`tools/result: successfully injected ${matchedRules.length} rules + ${matchedAgents.length} AGENTS.md for session ${sessionId}`);
      } catch (err) {
        log.error(`tools/result: failed to inject message: ${String(err)}`);
      }
    } else {
      log.debug("tools/result: skipped — no exec.agent");
    }
  });
  log.info(`tools/result handler registered, disposer=${typeof disposer2}`);

  // Log plugin lifecycle events.
  ctx.on("dispose", () => {
    log.info("=== Plugin dispose() called ===");
    log.info(`final stats: ${rules.length} rules discovered, ${touched.size} unique paths touched`);
  });
}