import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverRules, findRepoRoot } from "./discover";
import { matchRule, normalizePath } from "./match";
import { formatRules } from "./format";
import type { Rule } from "./rule";

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const GLOBS_TOOLS = new Set(["glob"]);

// Only the glob tool address targets via `pattern`; the path-based tools
// (read/edit/write/grep/find/ls) use `path`. Falling back to `pattern` for the
// latter would wrongly treat a grep/find search regex as a touched file path.
export function capturePath(
  name: string,
  input: Record<string, unknown> | undefined,
): string | undefined {
  const p = GLOBS_TOOLS.has(name) ? input?.pattern : input?.path;
  if (typeof p !== "string" || p === "") return undefined;
  return p;
}

export default function claudeRules(pi: ExtensionAPI): void {
  let rules: Rule[] = [];
  let repoRoot = "";
  const touched = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    // Normalize paths against the actual repo root (walk up to .git), so
    // repo-relative rule globs (e.g. src/**/*.ts) match even when the session
    // starts from a subdirectory of the repository.
    repoRoot = findRepoRoot(ctx.cwd);
    rules = await discoverRules(ctx.cwd);
    if (rules.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`claude-rules: ${rules.length} rule(s) found`, "info");
    }
  });

  pi.on("tool_call", async (event) => {
    const name = event.toolName;
    const input = event.input as Record<string, unknown>;
    if (!PATH_TOOLS.has(name) && !GLOBS_TOOLS.has(name)) return;
    const p = capturePath(name, input);
    if (p === undefined) return;
    touched.add(normalizePath(p, repoRoot));
  });

  pi.on("before_agent_start", async (event) => {
    if (rules.length === 0) return;
    const matched = rules.filter((r) => matchRule(r, [...touched]));
    if (matched.length === 0) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + formatRules(matched),
    };
  });
}