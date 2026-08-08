import { describe, expect, test } from "bun:test";
import { parseRule } from "../src/rule";
import { matchRule } from "../src/match";
import { formatRules } from "../src/format";
import { normalizePath } from "../src/match";

// The extension body is thin event wiring; the testable core is covered by the
// pure-function tests. This test asserts the wiring contract: that index.ts
// exports a callable default factory (the same shape the loader expects).
test("index.ts default-exports a factory function", async () => {
  const mod = await import("../src/index");
  expect(typeof mod.default).toBe("function");
});

test("integration: parse → match → format", () => {
  const rule = parseRule("/r/.claude/rules/ts.md", "ts.md", "---\npaths: [**/*.ts]\n---\nTS rules", 1);
  const touched = [normalizePath("/r/src/x.ts", "/r")];
  expect(matchRule(rule, touched)).toBe(true);
  const out = formatRules([rule]);
  expect(out).toContain("TS rules");
  expect(out).toContain("## ts.md");
});