import type { Rule } from "./rule";

export function formatRules(rules: Rule[]): string {
  if (rules.length === 0) return "";
  const sections = rules.map(
    (r) => `## ${r.relPath}\n\n${r.body.trim()}\n`
  );
  return (
    `# Claude Code Rules\n\nThe following rules apply to the files you are\n` +
    `currently working on. Follow them for matching paths.\n\n` +
    sections.join("\n---\n\n") +
    `\n`
  );
}