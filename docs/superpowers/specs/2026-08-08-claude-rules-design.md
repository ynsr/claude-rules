# Design: `claude-rules` — path-driven Claude Code rule injection extension for omp + Pi

**Status:** Approved design · **Date:** 2026-08-08 · **Repo:** `ynsr/claude-rules` (new)

## 1. Problem

Claude Code ships a `.claude/rules/*.md` convention: per-topic rule files with optional YAML
frontmatter whose `paths` field (a glob list) scopes each rule to the files it governs;
rules without `paths` are always-apply. Because the model automatically reads these using the
`read` tool plus the `paths` metadata, working on a matching file pulls the right guidance in.

omp (and its Pi lineage) already discover `.claude/CLAUDE.md` context files, but they do **not**
read `.claude/rules/*.md`. The bundled `examples/extensions/claude-rules.ts` only *lists* the
rule filenames in the system prompt and asks the model to read them on demand — it does not
implement `paths`-based automatic injection.

**Goal:** a standalone extension (hook) that discovers `.claude/rules/*.md`, reads the `paths`
frontmatter, tracks which files the session actually touches, and injects the matching rules'
content directly into the system prompt when the session is working on matching paths.

## 2. Scope decisions (approved)

- **Matching: Claude-native only.** Honor `paths` globs + `description`; no frontmatter → always
  apply; support `!` negation. Do not port opencode-rules' extra dimensions (`keywords`, `tools`,
  `model`, branch, os, ci, `match`).
- **Runtime: both omp and Pi.** One `ExtensionAPI` file works in both, because omp routes hook
  files through the extension runner (`--hook` ≡ `--extension`).
- **Discovery: walk up, nearest-wins.** From cwd to repo root, load each depth's
  `.claude/rules/` independently (monorepo); append `~/.claude/rules/` (user) last.
- **Injection point: `before_agent_start` → `systemPrompt`.** Not the `context` event. Pi's
  `Message` type has no `system` role, so `context`-message injection is omp-only and unsafe for
  Pi. `before_agent_start` returning `{ systemPrompt }` appends to the system prompt string sent
  to every LLM call, chains across extensions, and is the pattern the bundled example uses.
- **Delivery: standalone package** in a new `ynsr/claude-rules` repo.

## 3. How the reference influenced the design

`frap129/opencode-rules` (OpenCode plugin) was studied as the match-mechanics reference:

- **Path capture from tool calls** (record `read`/`edit`/`write`/`glob`/`grep` path args) →
  adopted, adapted to omp/Pi's `tool_call` event whose args live in `event.input`.
- **Frontmatter parsing with mtime cache invalidation** → adopted.
- **Per-call re-evaluation + injection into the prompt** → adapted: opencode uses
  `system.transform`; we use pi/omp's `before_agent_start` → `systemPrompt`.
- opencode's extra frontmatter dimensions and its `messages.transform` history-rescan are
  **out of scope** (Claude-native only; incremental path tracking instead of full rescan).

## 4. Architecture

```
discovery (session_start + mtime-invalidate)
  ├─ <depth>/.claude/rules/**/*.{md,mdc}  per depth, cwd→repo root
  ├─ ~/.claude/rules/**/*.{md,mdc}        user scope, last
  └─ → Rule[] { file, relPath, name, paths[], description?, body }

path capture (tool_call)
  ├─ read/edit/write → input.path
  ├─ grep/find/ls   → input.path (optional)
  └─ normalize → repo-relative POSIX → session Set<string>

matching (before_agent_start, each turn)
  for rule in rules:
    no positive paths → include
    else → any touched path matches positive ∧ ¬ hidden by `!` negation → include
  → append formatted rules to event.systemPrompt

compaction (session_compact)
  → module-state touched-path Set persists; next before_agent_start re-injects
```

## 5. Components (pure, unit-testable)

### 5.1 `discoverRules(cwd)`
- Walk upward from `cwd` toward the repo root: continue while the directory has no `.git` entry
  and is not the user's home; stop at the first dir with a `.git` entry (treat its parent as the
  walk boundary) or at home. At each visited depth, if `<depth>/.claude/rules/` is non-empty,
  load its `.md`/`.mdc` files recursively.
- Append `~/.claude/rules/` (user scope) last.
- Result order = farther ancestors first, then nearer, then user (matches omp context-file
  prominence: later = more prominent).
- Dedup by absolute file path; duplicate filename → more-local wins.
- Skip hidden files/dirs (names starting with `.`).

### 5.2 `parseRule(content)`
- `---`-delimited YAML frontmatter → `{ paths: string[], description?, body }`.
- `paths` accepts a YAML string or string array; normalize to array.
- Patterns starting with `!` → negated list; the rest → positive list.
- No `paths` (or empty array) → always-apply rule.
- `description` kept as string if present.
- Malformed YAML / bad frontmatter → warn (log) + treat as always-apply, never throw.

### 5.3 `normalizePath(p, repoRoot)`
- If absolute and under `repoRoot` → repo-relative POSIX.
- Expand `~` if leading.
- Backslashes → `/`; strip trailing slash.
- Return as-is (relative) otherwise.

### 5.4 `matchRule(rule, touchedPaths)`
- No positive paths → matched (always-apply).
- Else: candidate = paths matching any positive glob; drop any path hidden by a negated glob;
  matched iff candidate non-empty.
- Glob matching via a small dependency-free `globToRegExp` (no external glob lib; works under
  omp's Bun and Pi's Node alike). Supports `**`, `*`, `?`, `{a,b}`, `[abc]`, `!` handled at the
  pattern-split layer.

### 5.5 `formatRules(matched)`
- A single block: header (`## Claude Code Rules …`) + one `## <relPath>` + body per rule.

## 6. Extension wiring (`index.ts`)

`ExtensionAPI` factory, import type from `@earendil-works/pi-coding-agent`:

- `pi.on("session_start", …)` → resolve `ctx.cwd`, (re)discover rules, notify via `ctx.ui`.
- `pi.on("tool_call", …)` → for path-bearing tools, `normalizePath(event.input.path, repoRoot)`
  → add to a module-scoped session `Set<string>`.
- `pi.on("before_agent_start", …)` → re-evaluate rules against the path set; if any match,
  return `{ systemPrompt: event.systemPrompt + "\n\n" + formatRules(matched) }`.
- `pi.on("session_compact", …)` → no-op beyond acknowledging state persists (paths live in
  module state, so next `before_agent_start` re-injects).

## 7. Corner cases handled

| Case | Behavior |
|---|---|
| No `.claude/rules` dir | zero-overhead no-op |
| Malformed YAML / bad frontmatter | warn + always-apply, never crash |
| `paths` as string vs array | normalized to array |
| `!` negation | excluded from matching |
| absolute vs relative paths | normalized to repo-relative POSIX |
| Windows separators / `~` | normalized |
| rules edited mid-session | mtime cache invalidation → re-parse |
| duplicate rule names | more-local wins |
| hidden files/dirs in rules dir | skipped |
| subagent sessions | discovery is cwd-relative → correct per subagent |
| per-turn re-injection | fresh `event.systemPrompt` each turn → no accumulation |

## 8. Testing

- **Bun test** on the pure functions (`parseRule`, `normalizePath`, `matchRule`, `globToRegExp`,
  `discoverRules`) against fixture `.claude/rules` trees.
- **Smoke:** install into a scratch project with fixture rules, start omp, touch a matching file,
  confirm the rule appears in the `before_agent_start` system prompt.

## 9. Out of scope

- opencode-rules' extra frontmatter dimensions (`keywords`, `tools`, `model`, `agent`, `command`,
  `project`, `branch`, `os`, `ci`, `match`).
- Full-message-history path rescanning (incremental tool-call tracking instead).
- A TUI status sidebar (opencode has one; not requested).