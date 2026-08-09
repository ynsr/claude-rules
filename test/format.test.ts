import { describe, expect, test } from "bun:test";
import { formatRules } from "../src/format";
import type { Rule } from "../src/rule";

test("formatRules starts each section with the rule's full path", () => {
  const rules: Rule[] = [
    { file: "/home/u/.claude/rules/a.md", relPath: "a.md", name: "a", paths: [], negated: [], body: "**A body**", alwaysApply: true, mtimeMs: 0 },
    { file: "/home/u/work/repo/.claude/rules/sub/b.md", relPath: "sub/b.md", name: "b", paths: ["src/**"], negated: [], body: "B body", alwaysApply: false, mtimeMs: 0 },
  ];
  const out = formatRules(rules);
  expect(out).toContain("Contents of /home/u/.claude/rules/a.md:");
  expect(out).toContain("**A body**");
  expect(out).toContain("Contents of /home/u/work/repo/.claude/rules/sub/b.md:");
  expect(out).toContain("B body");
  // The full path is the FIRST line of each section.
  expect(out.startsWith("Contents of /home/u/.claude/rules/a.md:")).toBe(true);
});

test("empty rules → empty string", () => {
  expect(formatRules([])).toBe("");
});