import { describe, expect, test } from "bun:test";
import { parseRule } from "../src/rule";
import { matchRule } from "../src/match";
import { formatRules } from "../src/format";
import { normalizePath } from "../src/match";
import { capturePath } from "../src/index";

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

test("grep/find without a path arg does not capture the pattern as a touched path", () => {
  // grep/find are path-based tools: without a `path`, they should not add
  // anything to the touched set (the search regex is NOT a file path).
  expect(capturePath("grep", { pattern: "src/**/*.ts" })).toBeUndefined();
  expect(capturePath("find", { pattern: "-name '*.ts'" })).toBeUndefined();
  expect(capturePath("grep", { path: "src", pattern: "TODO" })).toBe("src");
  expect(capturePath("read", { path: "src/x.ts" })).toBe("src/x.ts");
  // glob is pattern-addressed: it captures the pattern.
  expect(capturePath("glob", { pattern: "src/**/*.ts" })).toBe("src/**/*.ts");
  // Empty/undefined yields nothing.
  expect(capturePath("grep", {})).toBeUndefined();
  expect(capturePath("glob", { pattern: "" })).toBeUndefined();
});