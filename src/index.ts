import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverRules } from "./discover";
import { matchRule, normalizePath } from "./match";
import { formatRules } from "./format";
import type { Rule } from "./rule";

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const GLOBS_TOOLS = new Set(["glob"]);

export default function claudeRules(pi: ExtensionAPI): void {
  let rules: Rule[] = [];
  let repoRoot = "";
  const touched = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    repoRoot = ctx.cwd; // repo root resolved lazily on first path capture
    rules = await discoverRules(ctx.cwd);
    if (rules.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`claude-rules: ${rules.length} rule(s) found`, "info");
    }
  });

  pi.on("tool_call", async (event) => {
    const name = event.toolName;
    const input = event.input as Record<string, unknown>;
    if (!PATH_TOOLS.has(name) && !GLOBS_TOOLS.has(name)) return;
    const p = input?.path ?? input?.pattern;
    if (typeof p !== "string" || p === "") return;
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