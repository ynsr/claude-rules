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
import { homedir } from "node:os";
import { join, resolve, dirname, relative, sep } from "node:path";
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { findRepoRoot } from "../discover";
import { parseRule } from "../rule";
import type { Rule } from "../rule";
import { matchRule, normalizePath } from "../match";
import { formatRules } from "../format";

// ── Constants ───────────────────────────────────────────────────────────────

/** Tools whose arguments carry a `file_path` field. Matches DSH's tool naming. */
const FILE_TOUCH_TOOLS = new Set(["read", "write", "edit"]);

/** Subdirectories to scan for rule files, in order of precedence. */
const RULE_DIRS = [".dsh", ".claude"];

// ── Discovery ───────────────────────────────────────────────────────────────

/**
 * Collect rule files from a single rules directory (e.g. `<dir>/.dsh/rules/`).
 * Uses the same mtime-keyed cache as the omp discover module.
 */
const fileCache = new Map<string, { mtimeMs: number; rule: Rule }>();

function collectRules(rulesDir: string): Rule[] {
  const out: Rule[] = [];
  if (!existsSync(rulesDir)) return out;
  const entries = readdirSync(rulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = join(rulesDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRules(full));
    } else if (/\.(md|mdc)$/i.test(entry.name)) {
      try {
        const st = statSync(full);
        const cached = fileCache.get(full);
        let rule: Rule;
        if (cached && cached.mtimeMs === st.mtimeMs) {
          rule = cached.rule;
        } else {
          // relPath is the path relative to the rules root for display
          const rel = relative(rulesDir, full).split(sep).join("/");
          rule = parseRule(full, rel, readFileSync(full, "utf8"), st.mtimeMs);
          fileCache.set(full, { mtimeMs: st.mtimeMs, rule });
        }
        out.push(rule);
      } catch {
        // unreadable file: skip
      }
    }
  }
  return out;
}

/**
 * Walk from cwd to repo root, discovering rules in each `.dsh/rules/` and
 * `.claude/rules/` directory, then user-global `~/.dsh/rules/`.
 */
export function discoverDshRules(cwd: string): Rule[] {
  const root = findRepoRoot(cwd);
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
  // walk is cwd → root; reverse so ancestors come first, nearer last.
  for (const d of walk.reverse()) {
    for (const rd of RULE_DIRS) {
      rules.push(...collectRules(join(d, rd, "rules")));
    }
  }

  // User-global scope (~/.dsh/rules/ and ~/.claude/rules/).
  for (const rd of RULE_DIRS) {
    rules.push(...collectRules(join(homedir(), rd, "rules")));
  }

  // Dedup by absolute path, keep first occurrence. Duplicate filenames across
  // scopes: a later (more-local / user) entry wins, so remove earlier same-name.
  const seen = new Set<string>();
  const deduped: Rule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.file)) continue;
    seen.add(rule.file);
    const idx = deduped.findIndex((r) => r.name === rule.name);
    if (idx !== -1) deduped.splice(idx, 1);
    deduped.push(rule);
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
}

/**
 * Cordis plugin factory for path-scoped rule injection.
 *
 * Usage (cordis.yml):
 *   - id: dsh-rules
 *     name: '/path/to/claude-rules/src/dsh/plugin.ts'
 *     config:
 *       maxBytes: 65536
 */
export function apply(ctx: Context, config: DshRulesConfig = {}): void {
  const maxBytes = config.maxBytes ?? 65536;
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
    }
    return state;
  }

  // ── discover rules on the first file touch ──

  let discovered = false;

  function ensureDiscovered() {
    if (discovered) return;
    discovered = true;
    repoRoot = findRepoRoot(process.cwd());
    rules = discoverDshRules(process.cwd());
  }

  // Clear per-turn dedup sets at the start of each step.
  ctx.on("session/event", (...args: unknown[]) => {
    const session = args[0] as { id: string } | undefined;
    const event = args[1] as { type: string } | undefined;
    if (!session || !event) return;
    if (event.type === "step/start") {
      const state = sessionState.get(session.id);
      if (state) state.injectedThisTurn.clear();
    }
  });

  // ── listen for tool results ──

  ctx.on("tools/result", (...args: unknown[]) => {
    const exec = args[0] as {
      name: string; arguments: Record<string, unknown>;
      agent?: { session: { id: string }; inbox: { prepend: (target: string, msg: unknown) => void } };
    } | undefined;
    const result = args[1] as { isError: boolean } | undefined;
    if (!exec || !result) return;

    // Only process successful file-touch tools
    if (result.isError) return;
    if (!FILE_TOUCH_TOOLS.has(exec.name)) return;
    const filePath = exec.arguments.file_path;
    if (typeof filePath !== "string" || filePath.trim() === "") return;

    if (exec.agent) {
      ensureDiscovered();

      const norm = normalizePath(filePath.trim(), repoRoot);
      touched.add(norm);

      // Match rules against all touched paths
      const matched = rules.filter((r) => matchRule(r, [...touched]));
      if (matched.length === 0) return;

      const sessionId = exec.agent.session.id;
      const state = getSessionState(sessionId);

      // Filter out rules already injected this turn
      const fresh = matched.filter((r) => {
        const key = `${r.file}@${r.mtimeMs}`;
        if (state.injectedThisTurn.has(key)) return false;
        return true;
      });

      if (fresh.length === 0) return;

      // Mark as injected this turn
      for (const r of fresh) {
        state.injectedThisTurn.add(`${r.file}@${r.mtimeMs}`);
      }

      // Format and inject as a user-role message
      let text = formatDshRules(fresh);
      // Guard against the byte budget — truncate by dropping rules if needed
      if (Buffer.byteLength(text, "utf8") > maxBytes) {
        let remaining = fresh;
        while (remaining.length > 0 && Buffer.byteLength(formatDshRules(remaining), "utf8") > maxBytes) {
          remaining = remaining.slice(0, -1);
        }
        if (remaining.length === 0) return;
        text = formatDshRules(remaining);
      }

      exec.agent.inbox.prepend("next-step", createUserMessage({
        content: [{ type: "text", text }],
        source: { kind: "path-scoped-rules", form: "instructions" },
      }));
    }
  });
}