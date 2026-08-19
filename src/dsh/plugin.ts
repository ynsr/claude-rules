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
import { findRepoRoot } from "../discover.ts";
import { parseRule } from "../rule.ts";
import type { Rule } from "../rule.ts";
import { matchRule, normalizePath } from "../match.ts";
import { formatRules } from "../format.ts";

// ── Constants ───────────────────────────────────────────────────────────────

/** Tools whose arguments carry a `file_path` field. Matches DSH's tool naming. */
const FILE_TOUCH_TOOLS = new Set(["read", "write", "edit"]);

/** Subdirectories to scan for rule files, in order of precedence. */
const RULE_DIRS = [".dsh", ".claude"];

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
 *     name: '/path/to/claude-rules/src/dsh/plugin.ts'
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
  let repoRoot = "";
  const touched = new Set<string>();
  // Per-agent session state: rules already injected this turn
  const sessionState = new Map<string, {
    injectedThisTurn: Set<string>;
  }>();

  // ── helpers ──

  function getSessionState(sessionId: string) {
    let state = sessionState.get(sessionId);
    if (!state) {
      state = { injectedThisTurn: new Set() };
      sessionState.set(sessionId, state);
      log.debug(`getSessionState: created new state for session ${sessionId}`);
    }
    return state;
  }

  // ── discover rules on the first file touch ──

  let discovered = false;

  function ensureDiscovered() {
    if (discovered) {
      log.debug("ensureDiscovered: already discovered, skipping");
      return;
    }
    discovered = true;
    repoRoot = findRepoRoot(process.cwd());
    log.info(`ensureDiscovered: repoRoot=${repoRoot}, cwd=${process.cwd()}`);
    rules = discoverDshRules(process.cwd(), log);
    log.info(`ensureDiscovered: ${rules.length} rules loaded`);
  }

  // Clear per-turn dedup sets at the start of each step.
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
      const state = sessionState.get(session.id);
      if (state) {
        state.injectedThisTurn.clear();
        log.debug(`session/event: cleared injectedThisTurn for session ${session.id}`);
      } else {
        log.debug(`session/event: no state for session ${session.id} (not yet touched by tools/result)`);
      }
    }
  });
  log.info(`session/event handler registered, disposer=${typeof disposer1}`);

  // ── listen for tool results ──

  log.info("Registering tools/result handler…");
  const disposer2 = ctx.on("tools/result", (...args: unknown[]) => {
    const exec = args[0] as {
      name: string; arguments: Record<string, unknown>;
      agent?: { session: { id: string }; inbox: { prepend: (target: string, msg: unknown) => void } };
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
    if (!FILE_TOUCH_TOOLS.has(exec.name)) {
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

      ensureDiscovered();

      const norm = normalizePath(filePath.trim(), repoRoot);
      touched.add(norm);
      log.debug(`tools/result: normalized path="${norm}", touched.size=${touched.size}`);

      // Match rules against all touched paths
      const matched = rules.filter((r) => matchRule(r, [...touched]));
      log.info(`tools/result: ${matched.length} rules matched out of ${rules.length} total`);
      if (matched.length === 0) {
        log.debug("tools/result: no rules matched, returning");
        return;
      }

      const sessionId = exec.agent.session.id;
      const state = getSessionState(sessionId);

      // Filter out rules already injected this turn
      const fresh = matched.filter((r) => {
        const key = `${r.file}@${r.mtimeMs}`;
        if (state.injectedThisTurn.has(key)) {
          log.debug(`tools/result: already injected this turn: ${r.name} (${key})`);
          return false;
        }
        return true;
      });

      log.info(`tools/result: ${fresh.length} fresh rules out of ${matched.length} matched`);
      if (fresh.length === 0) {
        log.debug("tools/result: all matched rules already injected this turn, returning");
        return;
      }

      // Mark as injected this turn
      for (const r of fresh) {
        const key = `${r.file}@${r.mtimeMs}`;
        state.injectedThisTurn.add(key);
        log.debug(`tools/result: marked injected: ${r.name} (${key})`);
      }

      // Format and inject as a user-role message
      let text = formatDshRules(fresh);
      log.debug(`tools/result: formatted text length=${Buffer.byteLength(text, "utf8")} bytes, maxBytes=${maxBytes}`);

      // Guard against the byte budget — truncate by dropping rules if needed
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        log.warn(`tools/result: formatted text exceeds maxBytes (${Buffer.byteLength(text, "utf8")} > ${maxBytes}), truncating`);
        let remaining = fresh;
        while (remaining.length > 0 && Buffer.byteLength(formatDshRules(remaining), "utf8") > maxBytes) {
          remaining = remaining.slice(0, -1);
        }
        if (remaining.length === 0) {
          log.warn("tools/result: all rules dropped after truncation, nothing to inject");
          return;
        }
        text = formatDshRules(remaining);
        log.info(`tools/result: truncated to ${remaining.length} rules (${Buffer.byteLength(text, "utf8")} bytes)`);
      }

      try {
        exec.agent.inbox.prepend("next-step", createUserMessage({
          content: [{ type: "text", text }],
          source: { kind: "path-scoped-rules", form: "instructions" },
        }));
        log.info(`tools/result: successfully injected ${fresh.length} rules for session ${sessionId}`);
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