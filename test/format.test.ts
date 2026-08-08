import { describe, expect, test } from "bun:test";
import { formatRules } from "../src/format";
import type { Rule } from "../src/rule";

test("formatRules builds a headed block with per-rule sections", () => {
  const rules: Rule[] = [
    { file: "/a.md", relPath: "a.md", name: "a", paths: [], negated: [], body: "**A body**", alwaysApply: true, mtimeMs: 0 },
    { file: "/b.md", relPath: "sub/b.md", name: "b", paths: ["src/**"], negated: [], body: "B body", alwaysApply: false, mtimeMs: 0 },
  ];
  const out = formatRules(rules);
  expect(out).toContain("## a.md");
  expect(out).toContain("**A body**");
  expect(out).toContain("## sub/b.md");
  expect(out).toContain("B body");
  expect(out.startsWith("# Claude Code Rules")).toBe(true);
});

test("empty rules → empty string", () => {
  expect(formatRules([])).toBe("");
});