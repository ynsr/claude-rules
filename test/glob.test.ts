import { describe, expect, test } from "bun:test";
import { globToRegExp, matchGlob } from "../src/glob";

describe("globToRegExp", () => {
  test("literal path", () => {
    expect(matchGlob("src/foo.ts", "src/foo.ts")).toBe(true);
    expect(matchGlob("src/foo.ts", "src/bar.ts")).toBe(false);
  });

  test("single-asterisk within a segment", () => {
    expect(matchGlob("src/*.ts", "src/foo.ts")).toBe(true);
    expect(matchGlob("src/*.ts", "src/sub/foo.ts")).toBe(false);
  });

  test("double-asterisk crosses segments", () => {
    expect(matchGlob("src/**/*.ts", "src/foo.ts")).toBe(true);
    expect(matchGlob("src/**/*.ts", "src/a/b/foo.ts")).toBe(true);
    expect(matchGlob("src/**/*.ts", "test/foo.ts")).toBe(false);
  });

  test("question mark matches one char", () => {
    expect(matchGlob("src/fo?.ts", "src/foo.ts")).toBe(true);
    expect(matchGlob("src/fo?.ts", "src/fo.ts")).toBe(false);
  });

  test("brace alternation", () => {
    expect(matchGlob("src/{a,b}.ts", "src/a.ts")).toBe(true);
    expect(matchGlob("src/{a,b}.ts", "src/b.ts")).toBe(true);
    expect(matchGlob("src/{a,b}.ts", "src/c.ts")).toBe(false);
  });

  test("character class", () => {
    expect(matchGlob("src/foo[0-9].ts", "src/foo5.ts")).toBe(true);
    expect(matchGlob("src/foo[0-9].ts", "src/fooX.ts")).toBe(false);
  });

  test("leading ** matches from root", () => {
    expect(matchGlob("**/*.test.ts", "a/b/x.test.ts")).toBe(true);
    expect(matchGlob("**/*.test.ts", "x.test.ts")).toBe(true);
  });
});