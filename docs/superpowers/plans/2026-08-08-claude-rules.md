# claude-rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a standalone omp+Pi extension that discovers `.claude/rules/*.md` files, reads their `paths` frontmatter, tracks the files a session touches, and injects matching rules into the system prompt.

**Architecture:** A single `ExtensionAPI` factory in `index.ts` (works in both omp and Pi because omp routes hook files through the extension runner). Pure, unit-testable functions handle discovery, frontmatter parsing, path normalization, glob matching, and formatting; the extension wires `session_start`, `tool_call`, and `before_agent_start` events. Injection happens by returning `{ systemPrompt: event.systemPrompt + … }` from `before_agent_start` (Pi's `Message` type has no `system` role, so `context`-event injection is avoided).

**Tech Stack:** TypeScript (ESM), Bun (runtime + test runner), `@earendil-works/pi-coding-agent` types. No external runtime dependencies (dependency-free glob matcher).

## Global Constraints

- TypeScript ESM (`"type": "module"`), runs under omp's Bun and Pi's Node.
- Factory signature: `export default function claudeRules(pi: ExtensionAPI): void`.
- Import types from `@earendil-works/pi-coding-agent` only for *types* (`import type`), never runtime imports, so the package has zero runtime deps.
- No external glob/YAML libraries at runtime. YAML frontmatter parsed with a minimal parser (key: value / array subset); glob matched with a self-written `globToRegExp`.
- Repo root walk: continue upward while the current dir has no `.git` entry and is not the user's home; stop at the first dir with a `.git` entry (treat its parent as the walk boundary) or at home.
- Path capture tools and their `event.input` path fields: `read`/`edit`/`write` → `input.path`; `grep`/`find`/`ls` → `input.path` (optional).
- Rule filename without extension is the rule name; dedup by absolute path, more-local filename wins.
- Hidden files/dirs (names starting with `.`) inside `.claude/rules/` are skipped.
- No frontmatter (or no/empty `paths`) → always-apply rule.
- `!`-prefixed patterns are negations; a rule matches if any touched path matches a positive glob and no touched path is hidden by a negated glob.
- Tests use Bun's built-in test runner (`bun test`). No test framework deps.

---

### Task 1: Scaffold package + first failing test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `test/glob.test.ts`
- Create: `src/glob.ts`

**Interfaces:**
- Produces: `src/glob.ts` exporting `globToRegExp(pattern: string): RegExp` and `matchGlob(pattern: string, relativePath: string): boolean`.

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "claude-rules",
  "version": "0.1.0",
  "description": "Inject Claude Code .claude/rules/*.md rules into omp/Pi based on paths frontmatter",
  "type": "module",
  "main": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "bun test"
  },
  "license": "MIT"
}
```

- [ ] **Step 2: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun"]
  },
  "include": ["src", "test"]
}
```

- [ ] **Step 3: Write the failing test `test/glob.test.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test test/glob.test.ts`
Expected: FAIL with "Cannot find module '../src/glob'". If `bun` is not on PATH, use `~/.bun/bin/bun`.

- [ ] **Step 5: Write minimal implementation `src/glob.ts`**

```ts
/**
 * Minimal dependency-free glob → RegExp translation.
 * Supports `**` (crosses segments), `*` (within a segment), `?` (one char),
 * `{a,b}` alternation, and `[abc]`/`[a-z]` character classes.
 * Patterns match against forward-slash relative paths.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  let i = 0;
  const n = pattern.length;

  while (i < n) {
    const c = pattern[i];

    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` — match zero or more segments (including none).
        out += "(?:.*/)?";
        i += 2;
        // Skip an immediately-following single slash.
        if (pattern[i] === "/") i++;
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === "{") {
      // Find matching closing brace; split on commas (no nesting support).
      const close = pattern.indexOf("}", i);
      if (close === -1) {
        out += "\\{";
        i++;
      } else {
        const inner = pattern.slice(i + 1, close);
        const parts = inner.split(",").map((p) => globToRegExp(p).source);
        out += `(?:${parts.join("|")})`;
        i = close + 1;
      }
    } else if (c === "[") {
      const close = pattern.indexOf("]", i);
      if (close === -1) {
        out += "\\[";
        i++;
      } else {
        out += pattern.slice(i, close + 1); // keep the class verbatim
        i = close + 1;
      }
    } else {
      out += c.replace(/[.+^$()|\\]/g, "\\$&");
      i++;
    }
  }

  return new RegExp(`^${out}$`);
}

export function matchGlob(pattern: string, relativePath: string): boolean {
  // Normalize backslashes; strip a leading `./`.
  const p = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return globToRegExp(pattern).test(p);
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test test/glob.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 7: Commit**

```bash
git add package.json tsconfig.json src/glob.ts test/glob.test.ts .gitignore
git commit -m "feat: add dependency-free glob matcher"
```

---

### Task 2: Frontmatter parsing + rule model

**Files:**
- Create: `src/rule.ts`
- Test: `test/rule.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `src/rule.ts` exporting:
  - `interface Rule { file: string; relPath: string; name: string; paths: string[]; negated: string[]; description?: string; body: string; alwaysApply: boolean; mtimeMs: number }`
  - `parseRule(file: string, relPath: string, content: string, mtimeMs: number): Rule` — never throws; malformed frontmatter → `alwaysApply: true` with full body.
  - `stripFrontmatter(content: string): string`
  - `parseFrontmatter(content: string): { paths: string[]; negated: string[]; description?: string }` — never throws; returns empty on malformed/absent frontmatter.

- [ ] **Step 1: Write the failing test `test/rule.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/rule.test.ts`
Expected: FAIL with "Cannot find module '../src/rule'".

- [ ] **Step 3: Write implementation `src/rule.ts`**

```ts
export interface Rule {
  file: string;        // absolute path
  relPath: string;     // path shown in the injected heading (relative to rules root)
  name: string;        // filename without extension
  paths: string[];     // positive glob patterns
  negated: string[];   // `!`-prefixed exclusion glob patterns (prefix stripped)
  description?: string;
  body: string;        // frontmatter stripped
  alwaysApply: boolean;
  mtimeMs: number;
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  return content.slice(end + 4).replace(/^\n/, "");
}

/**
 * Minimal YAML-frontmatter parser for the subset claude-rules needs:
 * `paths` (string or list), `description` (string). Values are parsed from
 * simple `key: value` lines and `- item` list lines. On any malformed input
 * it returns empty metadata (never throws).
 */
export function parseFrontmatter(content: string): {
  paths: string[];
  negated: string[];
  description?: string;
} {
  const out = { paths: [] as string[], negated: [] as string[], description: undefined as string | undefined };

  if (!content.startsWith("---")) return out;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return out;
  const block = content.slice(3, end);

  let current: "paths" | null = null;
  for (const rawLine of block.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const listItem = line.match(/^-\s*(.+)$/);
    if (listItem && current) {
      out[current].push(cleanScalar(listItem[1]));
      continue;
    }

    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const value = kv[2].trim();
    current = key === "paths" ? "paths" : null;

    if (key === "paths") {
      if (!value) continue;
      // Inline array `[a, b]` or single string.
      const inline = value.match(/^\[(.*)\]$/);
      if (inline) {
        for (const item of inline[1].split(",")) {
          const s = cleanScalar(item);
          if (s) out.paths.push(s);
        }
      } else if (value) {
        out.paths.push(cleanScalar(value));
      }
    } else if (key === "description" && value) {
      out.description = cleanScalar(value);
    }
  }

  // Split negations out of `paths`.
  const negated: string[] = [];
  const paths: string[] = [];
  for (const p of out.paths) {
    if (p.startsWith("!")) negated.push(p.slice(1));
    else paths.push(p);
  }
  out.paths = paths;
  out.negated = negated;
  return out;
}

function cleanScalar(s: string): string {
  return s.replace(/^['"]/, "").replace(/['"]$/, "").trim();
}

export function parseRule(
  file: string,
  relPath: string,
  content: string,
  mtimeMs: number
): Rule {
  const fm = parseFrontmatter(content);
  const body = stripFrontmatter(content);
  const name = file.split("/").pop()!.replace(/\.(md|mdc)$/i, "");
  const alwaysApply = fm.paths.length === 0;
  return {
    file,
    relPath,
    name,
    paths: fm.paths,
    negated: fm.negated,
    description: fm.description,
    body,
    alwaysApply,
    mtimeMs,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/rule.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/rule.ts test/rule.test.ts
git commit -m "feat: parse claude-rules frontmatter and rule model"
```

---

### Task 3: Path normalization + rule matching

**Files:**
- Create: `src/match.ts`
- Test: `test/match.test.ts`

**Interfaces:**
- Consumes: `Rule` from `src/rule.ts`; `matchGlob` from `src/glob.ts`.
- Produces: `src/match.ts` exporting:
  - `normalizePath(p: string, repoRoot: string): string` — absolute-under-repoRoot → repo-relative POSIX; expands `~`; backslashes → `/`; strips trailing slash; else returns as-is.
  - `matchRule(rule: Rule, touchedPaths: string[]): boolean` — alwaysApply → true; else positive glob vs any touched path, minus negated.

- [ ] **Step 1: Write the failing test `test/match.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/match.test.ts`
Expected: FAIL with "Cannot find module '../src/match'".

- [ ] **Step 3: Write implementation `src/match.ts`**

```ts
import os from "node:os";
import path from "node:path";
import { matchGlob } from "./glob";
import type { Rule } from "./rule";

export function normalizePath(p: string, repoRoot: string): string {
  let s = p;
  if (s === "~") s = os.homedir();
  else if (s.startsWith("~/")) s = path.join(os.homedir(), s.slice(2));

  const abs = path.isAbsolute(s) ? s : path.resolve(repoRoot, s);
  const rel = path.relative(repoRoot, abs);
  // If the path is outside repoRoot, keep a normalized absolute form.
  let out = rel.startsWith("..") ? abs : rel;
  out = out.split(path.sep).join("/");
  out = out.replace(/^\.\//, "");
  return out.replace(/\/+$/, "");
}

export function matchRule(rule: Rule, touchedPaths: string[]): boolean {
  if (rule.alwaysApply) return true;
  if (rule.paths.length === 0) return false;

  const positiveHit = touchedPaths.some((tp) =>
    rule.paths.some((pattern) => matchGlob(pattern, tp))
  );
  if (!positiveHit) return false;

  const negatedHit = touchedPaths.some((tp) =>
    rule.negated.some((pattern) => matchGlob(pattern, tp))
  );
  return !negatedHit;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/match.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/match.ts test/match.test.ts
git commit -m "feat: path normalization and rule matching"
```

---

### Task 4: Rule discovery (walk-up + user scope)

**Files:**
- Create: `src/discover.ts`
- Test: `test/discover.test.ts`

**Interfaces:**
- Consumes: `parseRule`, `Rule` from `src/rule.ts`.
- Produces: `src/discover.ts` exporting:
  - `discoverRules(cwd: string): Promise<Rule[]>` — walk cwd→repo root, load each depth's `.claude/rules`, append user `~/.claude/rules`; mtime-cached.
  - `clearRuleCache(): void` — for tests/hot reload.
  - `findRepoRoot(cwd: string): string` — first ancestor with `.git` (inclusive) else home.

- [ ] **Step 1: Write the failing test `test/discover.test.ts`**

```ts
import { describe, expect, test, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { discoverRules, clearRuleCache, findRepoRoot } from "../src/discover";

let tmp: string;
beforeEach(() => {
  clearRuleCache();
  tmp = mkdtempSync(path.join(tmpdir(), "claude-rules-"));
});

test.afterAll(() => {
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/discover.test.ts`
Expected: FAIL with "Cannot find module '../src/discover'".

- [ ] **Step 3: Write implementation `src/discover.ts`**

```ts
import { readdirSync, readFileSync, statSync, existsSync, homedir } from "node:fs";
import path from "node:path";
import type { Rule } from "./rule";

const cache = new Map<string, { mtimeMs: number; rule: Rule }>();

export function clearRuleCache(): void {
  cache.clear();
}

export function findRepoRoot(cwd: string): string {
  let dir = path.resolve(cwd);
  const home = homedir();
  for (;;) {
    if (dir === home) return dir;
    if (existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
}

function collectRules(rulesDir: string, base: string): Rule[] {
  const out: Rule[] = [];
  if (!existsSync(rulesDir)) return out;
  const entries = readdirSync(rulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(rulesDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectRules(full, base));
    } else if (/\.(md|mdc)$/i.test(entry.name)) {
      const rel = path.relative(base, full).split(path.sep).join("/");
      try {
        const st = statSync(full);
        const cached = cache.get(full);
        let rule: Rule;
        if (cached && cached.mtimeMs === st.mtimeMs) {
          rule = cached.rule;
        } else {
          rule = parseRule(full, rel, readFileSync(full, "utf8"), st.mtimeMs);
          cache.set(full, { mtimeMs: st.mtimeMs, rule });
        }
        out.push(rule);
      } catch {
        // unreadable file: skip
      }
    }
  }
  return out;
}

export async function discoverRules(cwd: string): Promise<Rule[]> {
  const root = findRepoRoot(cwd);
  const rules: Rule[] = [];

  // Walk from cwd (inclusive) down to repo root, collecting each depth's rules.
  let dir = path.resolve(cwd);
  const walk: string[] = [];
  for (;;) {
    walk.push(dir);
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // walk is cwd → root; reverse so ancestors come first, nearer last.
  for (const d of walk.reverse()) {
    rules.push(...collectRules(path.join(d, ".claude", "rules"), path.join(d, ".claude", "rules")));
  }

  // User scope last.
  const userRules = path.join(homedir(), ".claude", "rules");
  rules.push(...collectRules(userRules, userRules));

  // Dedup by absolute path, keep first occurrence. Duplicate filenames across
  // scopes: a later (more-local / user) entry wins, so remove earlier same-name.
  const seen = new Set<string>();
  const deduped: Rule[] = [];
  for (const rule of rules) {
    if (seen.has(rule.file)) continue;
    seen.add(rule.file);
    // Drop any earlier rule with the same name (more-local wins).
    const idx = deduped.findIndex((r) => r.name === rule.name);
    if (idx !== -1) deduped.splice(idx, 1);
    deduped.push(rule);
  }
  return deduped;
}
```

> Note: `parseRule` is referenced here but defined in `src/rule.ts` from Task 2; add `import { parseRule } from "./rule";` to the top of `src/discover.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/discover.test.ts`
Expected: PASS (all tests). Add the missing `import { parseRule } from "./rule";` line if the file lacks it.

- [ ] **Step 5: Commit**

```bash
git add src/discover.ts test/discover.test.ts
git commit -m "feat: discover claude rules with walk-up and user scope"
```

---

### Task 5: Formatting

**Files:**
- Create: `src/format.ts`
- Test: `test/format.test.ts`

**Interfaces:**
- Consumes: `Rule` from `src/rule.ts`.
- Produces: `src/format.ts` exporting `formatRules(rules: Rule[]): string`.

- [ ] **Step 1: Write the failing test `test/format.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/format.test.ts`
Expected: FAIL with "Cannot find module '../src/format'".

- [ ] **Step 3: Write implementation `src/format.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format.ts test/format.test.ts
git commit -m "feat: format matched rules for system prompt injection"
```

---

### Task 6: Extension wiring (index.ts)

**Files:**
- Create: `src/index.ts`
- Test: `test/index.test.ts`

**Interfaces:**
- Consumes: `discoverRules` (`src/discover.ts`), `matchRule` + `normalizePath` (`src/match.ts`), `formatRules` (`src/format.ts`), `Rule`.
- Produces: `src/index.ts` default-exporting `claudeRules(pi: ExtensionAPI): void`.

- [ ] **Step 1: Write the failing test `test/index.test.ts`**

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/index.test.ts`
Expected: FAIL — module load error (no `../src/index` yet).

- [ ] **Step 3: Write implementation `src/index.ts`**

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discoverRules } from "./discover";
import { matchRule, normalizePath } from "./match";
import { formatRules } from "./format";
import type { Rule } from "./rule";

const PATH_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const GLOBS_TOOLS = new Set(["glob"]);

export default function claudeRules(pi: ExtensionAPI): void {
  let rules: Rule[] = [];
  let repoRoot = "";
  const touched = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    repoRoot = ctx.cwd; // repo root resolved lazily on first path capture
    rules = await discoverRules(ctx.cwd);
    if (rules.length > 0 && ctx.hasUI) {
      ctx.ui.notify(`claude-rules: ${rules.length} rule(s) found`, "info");
    }
  });

  pi.on("tool_call", async (event) => {
    const name = event.toolName;
    const input = event.input as Record<string, unknown>;
    if (!PATH_TOOLS.has(name) && !GLOBS_TOOLS.has(name)) return;
    const p = input?.path ?? input?.pattern;
    if (typeof p !== "string" || p === "") return;
    touched.add(normalizePath(p, repoRoot));
  });

  pi.on("before_agent_start", async (event) => {
    if (rules.length === 0) return;
    const matched = rules.filter((r) => matchRule(r, [...touched]));
    if (matched.length === 0) return;
    return {
      systemPrompt: event.systemPrompt + "\n\n" + formatRules(matched),
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/index.test.ts`
Expected: PASS. The `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"` resolves
against the copy installed in `~/.omp/plugins/node_modules` (the same one omp loads). If the
package is not resolvable from the project (e.g. clean clone without omp), add it as a dev
dependency (`bun add -d @earendil-works/pi-coding-agent`) so type-checking works.

- [ ] **Step 5: Type-check**

Run: `~/.bun/bin/bun x tsc --noEmit`
Expected: no type errors reported.

- [ ] **Step 6: Commit**

```bash
git add src/index.ts test/index.test.ts
git commit -m "feat: wire extension events for path-driven rule injection"
```

---

### Task 7: README + self-hosting example rules

**Files:**
- Create: `README.md`
- Create: `.claude/rules/ts-style.md`
- Create: `.claude/rules/api-design.md`

**Interfaces:** none (docs + dogfood rules).

- [ ] **Step 1: Write `README.md`**

```markdown
# claude-rules

Injects Claude Code `.claude/rules/*.md` rules into omp / Pi based on the `paths`
frontmatter property. When the session touches a file matching a rule's `paths`,
that rule's content is injected into the system prompt.

## Why

Claude Code supports `.claude/rules/*.md` files with `paths` frontmatter that scope
rules to matching files. omp and Pi read `.claude/CLAUDE.md` but not
`.claude/rules/*.md`. This extension closes that gap.

## Install

Drop `src/index.ts` into your extension directory:

- **omp:** `~/.omp/agent/extensions/claude-rules.ts`
- **Pi:** `~/.pi/agent/extensions/claude-rules.ts`

Or add it via `config.yml`:

```yaml
extensions:
  - /path/to/claude-rules/src/index.ts
```

## Rule format

`.claude/rules/*.md` files optionally start with YAML frontmatter:

```markdown
---
paths:
  - 'src/**/*.ts'
  - '!src/generated/**'
description: TypeScript conventions
---

Prefer `const` over `let`. Use interfaces for objects.
```

- `paths` — glob list scoping the rule. Missing or empty → always apply.
- `!` prefix — exclusion glob.
- `description` — optional, informational.
- Nest rules in subdirectories; hidden files/dirs are skipped.

## Discovery

Rules are discovered from every `.claude/rules/` directory walking from the current
working directory up to the repo root (a directory containing `.git`), plus
`~/.claude/rules/` (user scope, applied last). More-local rules win on name
collisions.

## Matching

A rule is injected when any touched file (from `read`/`edit`/`write`/`grep`/`find`/
`ls`/`glob` tool calls) matches a positive `paths` glob and is not hidden by a
negated one. Rules without `paths` always apply.

## Development

```bash
bun test        # run the unit tests
```
```

- [ ] **Step 2: Write self-hosting example rule `.claude/rules/ts-style.md`**

```markdown
---
paths:
  - 'src/**/*.ts'
description: TypeScript style
---

Use `const` over `let` unless reassignment is required. Prefer interfaces over
type aliases for object shapes. Keep functions small and single-purpose.
```

- [ ] **Step 3: Write self-hosting example rule `.claude/rules/api-design.md`**

```markdown
---
paths:
  - 'src/**'
  - '!**/*.test.ts'
description: API design guardrails
---

Prefer explicit error returns over thrown exceptions for expected failure modes.
Keep public API surface minimal; add exports only when a consumer needs them.
```

- [ ] **Step 4: Run the full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add README.md .claude/rules/ts-style.md .claude/rules/api-design.md
git commit -m "docs: README and self-hosting example rules"
```

---

### Task 8: omp smoke test

**Files:** none (manual verification).

- [ ] **Step 1: Install the extension into omp**

```bash
mkdir -p ~/.omp/agent/extensions
cp ~/projects/personal/claude-rules/src/index.ts ~/.omp/agent/extensions/claude-rules.ts
```

- [ ] **Step 2: Create a scratch project with a matching rule**

```bash
mkdir -p /tmp/claude-rules-smoke/.claude/rules
cat > /tmp/claude-rules-smoke/.claude/rules/ts.md <<'EOF'
---
paths:
  - '**/*.ts'
---
TypeScript rule: always use `const` in this smoke project.
EOF
```

- [ ] **Step 3: Start omp in the scratch project and read a `.ts` file**

Run `omp` in `/tmp/claude-rules-smoke`, then read `a.ts` (create it first). Confirm the
injected system prompt contains `## ts.md` and "always use `const`".

Expected: the rule appears in the system prompt after a `.ts` file is touched.

- [ ] **Step 4: Remove the smoke-test install**

```bash
rm ~/.omp/agent/extensions/claude-rules.ts
```

---

## Self-Review Summary

- **Spec coverage:** discovery (Task 4), frontmatter parsing + rule model (Task 2),
  path capture in wiring (Task 6), normalization + matching (Task 3), formatting (Task 5),
  injection via `before_agent_start` (Task 6), mtime cache (Task 4), dedup/more-local wins
  (Task 4), hidden-file skip (Task 4), corner cases (malformed → always-apply, Task 2),
  README + dogfood (Task 7), omp smoke (Task 8). All spec sections covered.
- **Placeholder scan:** no TBD/TODO; every code step has concrete code.
- **Type consistency:** `Rule` shape (`file`, `relPath`, `name`, `paths`, `negated`,
  `description?`, `body`, `alwaysApply`, `mtimeMs`) is defined once in Task 2 and used
  consistently through Tasks 3–6. `normalizePath(p, repoRoot)`, `matchRule(rule,
  touchedPaths)`, `formatRules(rules)`, `discoverRules(cwd)` signatures are stable across
  tasks.