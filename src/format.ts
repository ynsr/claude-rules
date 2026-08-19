import type { Rule } from "./rule.ts";

/**
 * Format injected rules so each section's first line is the FULL path of the
 * rule file (e.g. `Contents of /path/to/.claude/rules/ts.md:`), followed by the
 * rule body. Sections are separated by `---`. This mirrors how Claude Code
 * labels injected rule content and gives the model the exact file each rule
 * came from.
 */
export function formatRules(rules: Rule[]): string {
  if (rules.length === 0) return "";
  const sections = rules.map((r) => `Contents of ${r.file}:\n\n${r.body.trim()}\n`);
  return sections.join("\n---\n\n") + "\n";
}