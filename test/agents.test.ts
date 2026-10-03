import { describe, expect, test, beforeEach, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { clearAgentCache, discoverAgents, matchAgent } from "../src/agents";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), "agents-"));
  clearAgentCache();
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = path.join(tmp, "r");
  mkdirSync(path.join(repo, "sub", "deep"), { recursive: true });
  writeFileSync(path.join(repo, ".git"), "");
  writeFileSync(path.join(repo, "AGENTS.md"), "# Root\nroot doc\n");
  writeFileSync(path.join(repo, "sub", "AGENTS.md"), "# Sub\nsub doc\n");
  writeFileSync(path.join(repo, "sub", "deep", "AGENTS.md"), "# Deep\ndeep doc\n");
  return repo;
}

describe("agents", () => {
  test("discovers nested AGENTS.md root-first, skipping the cwd file", () => {
    const repo = makeRepo();
    // Session at leaf: cwd file skipped, ancestors root → sub returned.
    const leaf = discoverAgents(path.join(repo, "sub", "deep"));
    expect(leaf.map((d) => d.file)).toEqual([
      path.join(repo, "AGENTS.md"),
      path.join(repo, "sub", "AGENTS.md"),
    ]);
    // Session at repo root: the root file is harness-owned → nothing returned.
    expect(discoverAgents(repo)).toEqual([]);
  });

  test("matches only touched paths under the doc scope dir", () => {
    const repo = makeRepo();
    const docs = discoverAgents(path.join(repo, "sub", "deep"));
    const root = docs[0];
    const sub = docs[1];
    if (!root || !sub) throw new Error("expected two agent docs");
    expect(matchAgent(root, ["sub/deep/x.ts"], repo)).toBe(true);
    expect(matchAgent(sub, ["sub/deep/x.ts"], repo)).toBe(true);
    expect(matchAgent(sub, ["other/x.ts"], repo)).toBe(false);
    expect(matchAgent(root, ["other/x.ts"], repo)).toBe(true);
  });
});
