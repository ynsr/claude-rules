import { describe, expect, test } from "bun:test";
import { parseRule, parseFrontmatter, stripFrontmatter } from "../src/rule";

describe("parseFrontmatter", () => {
  test("absent frontmatter", () => {
    expect(parseFrontmatter("# Title\n\nbody")).toEqual({
      paths: [],
      negated: [],
      description: undefined,
    });
  });

  test("paths as array", () => {
    expect(parseFrontmatter("---\npaths:\n  - src/**/*.ts\n  - lib/**/*.js\n---\nbody")).toEqual({
      paths: ["src/**/*.ts", "lib/**/*.js"],
      negated: [],
      description: undefined,
    });
  });

  test("paths as single string", () => {
    expect(parseFrontmatter("---\npaths: src/**/*.ts\n---\nbody")).toEqual({
      paths: ["src/**/*.ts"],
      negated: [],
      description: undefined,
    });
  });

  test("negation patterns", () => {
    expect(parseFrontmatter("---\npaths:\n  - src/**\n  - '!src/generated/**'\n---\nbody")).toEqual({
      paths: ["src/**"],
      negated: ["src/generated/**"],
      description: undefined,
    });
  });

  test("description", () => {
    expect(parseFrontmatter("---\npaths: [src/**]\ndescription: API rules\n---\nbody")).toEqual({
      paths: ["src/**"],
      negated: [],
      description: "API rules",
    });
  });

  test("malformed YAML does not throw", () => {
    expect(() => parseFrontmatter("---\npaths: [unterminated\n---\nbody")).not.toThrow();
  });
});

describe("stripFrontmatter", () => {
  test("strips frontmatter block", () => {
    expect(stripFrontmatter("---\npaths: [a]\n---\n**body**")).toBe("**body**");
  });
  test("no frontmatter returns as-is", () => {
    expect(stripFrontmatter("# Title\n\nbody")).toBe("# Title\n\nbody");
  });
});

describe("parseRule", () => {
  test("no frontmatter → alwaysApply", () => {
    const r = parseRule("/x/.claude/rules/a.md", "a.md", "# A\n\nbody", 1);
    expect(r.alwaysApply).toBe(true);
    expect(r.body).toBe("# A\n\nbody");
    expect(r.name).toBe("a");
  });

  test("with paths → not alwaysApply", () => {
    const r = parseRule("/x/.claude/rules/a.md", "a.md", "---\npaths: [src/**]\n---\nbody", 1);
    expect(r.alwaysApply).toBe(false);
    expect(r.paths).toEqual(["src/**"]);
  });

  test("empty paths → alwaysApply", () => {
    const r = parseRule("/x/.claude/rules/a.md", "a.md", "---\npaths: []\n---\nbody", 1);
    expect(r.alwaysApply).toBe(true);
  });

  test("malformed frontmatter → alwaysApply, does not throw", () => {
    const r = parseRule("/x/.claude/rules/a.md", "a.md", "---\npaths: [bad\n---\nbody", 1);
    expect(r.alwaysApply).toBe(true);
  });
});