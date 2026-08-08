import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverRules, clearRuleCache, findRepoRoot } from "../src/discover";

let tmp: string;
beforeEach(() => {
  clearRuleCache();
  tmp = mkdtempSync(path.join(tmpdir(), "claude-rules-"));
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

test("findRepoRoot stops at .git", () => {
  const repo = path.join(tmp, "r");
  mkdirSync(path.join(repo, "pkg"), { recursive: true });
  writeFileSync(path.join(repo, ".git"), "");
  const root = findRepoRoot(path.join(repo, "pkg"));
  expect(root).toBe(repo);
});

test("discoverRules walks repo and finds nested rules", async () => {
  const repo = path.join(tmp, "r");
  mkdirSync(path.join(repo, "pkg", ".claude", "rules"), { recursive: true });
  mkdirSync(path.join(repo, ".claude", "rules"), { recursive: true });
  writeFileSync(path.join(repo, ".git"), "");
  writeFileSync(path.join(repo, ".claude", "rules", "a.md"), "---\npaths: [src/**]\n---\nA");
  writeFileSync(path.join(repo, "pkg", ".claude", "rules", "b.md"), "---\npaths: [pkg/**]\n---\nB");

  const rules = await discoverRules(path.join(repo, "pkg"));
  const names = rules.map((r) => r.name).sort();
  expect(names).toEqual(["a", "b"]);
});

test("discoverRules skips non-md files and hidden entries", async () => {
  const repo = path.join(tmp, "r");
  mkdirSync(path.join(repo, ".claude", "rules", ".hidden"), { recursive: true });
  writeFileSync(path.join(repo, ".git"), "");
  writeFileSync(path.join(repo, ".claude", "rules", "ok.md"), "ok");
  writeFileSync(path.join(repo, ".claude", "rules", "skip.txt"), "skip");
  writeFileSync(path.join(repo, ".claude", "rules", ".hidden", "x.md"), "x");

  const rules = await discoverRules(repo);
  expect(rules.map((r) => r.name)).toEqual(["ok"]);
});

test("no rules directory → empty", async () => {
  const repo = path.join(tmp, "r");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, ".git"), "");
  const rules = await discoverRules(repo);
  expect(rules).toEqual([]);
});