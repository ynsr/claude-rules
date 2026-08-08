import { describe, expect, test } from "bun:test";
import { normalizePath, matchRule } from "../src/match";
import type { Rule } from "../src/rule";

const REPO = "/home/u/work/repo";

describe("normalizePath", () => {
  test("absolute under repoRoot → repo-relative", () => {
    expect(normalizePath("/home/u/work/repo/src/a.ts", REPO)).toBe("src/a.ts");
  });
  test("already relative → as-is", () => {
    expect(normalizePath("src/a.ts", REPO)).toBe("src/a.ts");
  });
  test("backslashes → forward slashes", () => {
    expect(normalizePath("src\\a.ts", REPO)).toBe("src/a.ts");
  });
  test("trailing slash stripped", () => {
    expect(normalizePath("src/", REPO)).toBe("src");
  });
  test("leading ./ stripped", () => {
    expect(normalizePath("./src/a.ts", REPO)).toBe("src/a.ts");
  });
});

function rule(partial: Partial<Rule>): Rule {
  return {
    file: "/x.md",
    relPath: "x.md",
    name: "x",
    paths: [],
    negated: [],
    body: "body",
    alwaysApply: false,
    mtimeMs: 0,
    ...partial,
  };
}

describe("matchRule", () => {
  test("alwaysApply matches regardless of paths", () => {
    expect(matchRule(rule({ alwaysApply: true }), [])).toBe(true);
  });

  test("positive glob matches a touched path", () => {
    expect(matchRule(rule({ paths: ["src/**/*.ts"] }), ["src/a/b.ts"])).toBe(true);
  });

  test("no matching path → false", () => {
    expect(matchRule(rule({ paths: ["src/**/*.ts"] }), ["test/a.ts"])).toBe(false);
  });

  test("negation hides a matching path", () => {
    const r = rule({ paths: ["src/**"], negated: ["src/generated/**"] });
    expect(matchRule(r, ["src/generated/x.ts"])).toBe(false);
    expect(matchRule(r, ["src/manual/x.ts"])).toBe(true);
  });

  test("empty touchedPaths and non-always rule → false", () => {
    expect(matchRule(rule({ paths: ["src/**"] }), [])).toBe(false);
  });
});