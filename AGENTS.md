# Repository Guidelines

## Project Overview

A Bun/TypeScript extension for **omp** (oh-my-pi) and **Pi** that closes Claude Code's `.claude/rules/*.md` gap. It discovers rule files, reads their `paths` frontmatter, tracks which files the session touches via tool calls, and injects matching rules' content into the conversation as user-role `<instructions>` blocks — mid-session, like Claude Code, rather than bulk-appended to the system prompt.

Entry point is `src/index.ts`, exporting a default factory `claudeRules(pi: ExtensionAPI): void`. The package has zero runtime dependencies — everything (glob engine, YAML subset parser, matching) is self-contained and dependency-free.

## Architecture & Data Flow

The extension is event-driven, registering handlers on the `ExtensionAPI`:

1. **`session_start`** — seeds module state: `findRepoRoot(ctx.cwd)` (walks up to `.git`), `discoverRules(ctx.cwd)` (collects rules), computes the token-gap threshold from `ctx.model?.contextWindow`, adopts `ctx.logger`.
2. **`tool_call`** — captures the tool's path arg (`capturePath`), normalizes it against `repoRoot`, and adds it to the `touched` Set. Path tools: `read`/`edit`/`write`/`grep`/`find`/`ls` (via `path`) and `glob` (via `pattern`).
3. **`before_agent_start`** — clears the per-turn dedup Set and appends `CONTEXT_NOTE` to the system prompt (so injected `<instructions>` is read as contextual feedback, not a hard command). Never bulk-injects rules here.
4. **`context`** (omp-only) — before each model step, injects matched rules. Guards: must match a touched path (`matchRule`), not already injected this turn (`injectedThisTurn` Set), and only if the conversation has grown past the token gap since last injection (`lastInjectedTokens` Map). Injected rules are appended as a user-role `<instructions>` message.

**Data flow:** `tool_call` captures path → `normalizePath` → `touched` Set → (omp `context` event) filter `rules` by `matchRule` + per-turn Set + token-gap Map → `formatRules` → appended user-role `<instructions>` message.

**Mid-turn re-injection:** X = `min(claimedWindow × 0.25, 70_000)`, fallback `70_000`. Tracked per-rule (keyed by `dedupKey` = `file@mtimeMs`) in `lastInjectedTokens`; current token count = `event.messages.reduce(estimateTokens)` (chars/4 heuristic from `@earendil-works/pi-coding-agent`).

## Key Directories

| Path | Purpose |
|---|---|
| `src/` | Extension source. `index.ts` (entry/factory), `discover.ts` (rule discovery + cache), `match.ts` (path match), `format.ts` (rendering), `rule.ts` (Rule type + frontmatter parsing), `glob.ts` (dependency-free glob matcher) |
| `test/` | `bun:test` unit + integration tests, one file per module plus `context.test.ts` (integration) |
| `.claude/rules/` | Dogfood rules shipped with the repo (`ts-style.md`, `api-design.md`, `security.md`) — they exercise the extension's own `paths` matching |
| `docs/superpowers/plans/` | Implementation plan (historical artifact; its architecture section is stale — see below) |

## Development Commands

```bash
bun test                # run the test suite (bun:test)
bun x tsc --noEmit      # typecheck (strict, noEmit; not scripted in package.json)
bun build src/index.ts --target=bun --outfile=claude-rules.ts   # build deployable bundle
cp claude-rules.ts ~/.omp/agent/extensions/   # install as drop-in copy (Option B)
```

- Install Option A (recommended): reference `src/index.ts` directly via `config.yml` `extensions:` — no bundle needed; relative imports resolve in-repo.
- Install Option B: bundle to a single self-contained file (relative imports would otherwise fail outside the repo).

## Code Conventions & Common Patterns

- **ESM** (`"type": "module"`), factory-export style: `export default function claudeRules(pi: ExtensionAPI)`.
- **Type-only imports** from `@earendil-works/pi-coding-agent` where possible (stripped at build); value imports like `estimateTokens` are the exception.
- **Never throw in parsers.** `parseFrontmatter`, `stripFrontmatter`, `globToRegExp` all degrade gracefully on malformed input (return empty metadata / literals). No empty try/catch; unreadable files skip via guarded try/catch.
- **Dependency-free primitives.** Glob translation and YAML-frontmatter parsing are hand-rolled in `glob.ts` / `rule.ts` — extend them in place rather than adding libraries.
- **Data structures:** `Set` for dynamic membership / runtime collections (`touched`, `injectedThisTurn`); `Map` for keyed runtime state (`lastInjectedTokens`); `Record` for small static lookup tables.
- **Per-path negation semantics** (in `matchRule`): a touched path must match a positive glob AND not be hidden by a negated glob; other negated touched paths don't disqualify.
- **`alwaysApply`** = `paths.length === 0` (after `!`-prefixed entries are split into `negated`).
- **omp detection** (`isOmp`): check `OMPCODE === "1"` fast path, then scan `PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR` for an `.omp` segment. `OMPCODE` alone is unreliable (set only in spawned shells, not the extension host).
- **Logging:** structured `ctx.logger` (falls back to `console.warn` in tests/mocks); module-load line uses `console.warn` before any ctx exists. No UI toasts.
- **Naming:** module files lowercase single-word (`match.ts`, `discover.ts`); rule discovery uses `{ name }` = filename minus `.md`/`.mdc`.

## Important Files

- `src/index.ts` — entry point + `claudeRules` factory; all event wiring; constants `TOKEN_GAP_CAP`/`TOKEN_GAP_FRACTION`/`TOKEN_GAP_FALLBACK`, `CONTEXT_NOTE`; helpers `isOmp`, `dedupKey`, `adoptLogger`, `capturePath`.
- `src/rule.ts` — `Rule` interface and frontmatter parsing; the source of truth for rule shape.
- `src/discover.ts` — `findRepoRoot`, `discoverRules` (cwd→repo-root walk + `~/.claude/rules`, more-local wins on name collisions, mtime-keyed cache), `clearRuleCache`.
- `src/match.ts` — `normalizePath`, `matchRule` (per-path negation).
- `src/glob.ts` — `globToRegExp`, `matchGlob` (segments, `**`, `?`, `{a,b}`, `[abc]`/`[a-z]`).
- `src/format.ts` — `formatRules` (`Contents of <absolute path>:` heading per rule).
- `test/context.test.ts` — integration tests; home of `makePi`, `withOmp`, `makeRepo`, `asHookResult`, `isInstructionsMessage` helpers.

## Runtime/Tooling Preferences

- **Runtime:** Bun (required — `bun:test`, `Bun.env`, `bun build`). Not Node.
- **Package manager:** `bun` (lockfile `bun.lock`).
- **Typecheck:** `bun x tsc --noEmit` (strict, `types: ["bun"]`, `moduleResolution: bundler`).
- **Extension type source:** `@earendil-works/pi-coding-agent` (dev dependency, `^0.84.1`).
- **Deploy artifact:** root `claude-rules.ts` is a gitignored bun build output, not source.

## Testing & QA

- **Framework:** `bun:test`; run with `bun test`. No coverage tooling configured.
- **Structure:** pure-unit tests per module (`glob`, `rule`, `match`, `format`, `discover`, `index`) test imported functions directly with hand-built `Rule` fixtures; `context.test.ts` is the only integration test — it instantiates `claudeRules` and drives the full event lifecycle through a mock pi.
- **Mock pi** (`makePi`): `Map<string, Handler[]>` registry; sequential awaited `emit` returning the last handler result. Events must fire in order `session_start → before_agent_start → tool_call → context`.
- **`withOmp(omp, fn)`** toggles BOTH `Bun.env.OMPCODE` and `PI_CODING_AGENT_DIR` (setting only `OMPCODE` would leave a real host-inherited `.omp` dir making `isOmp()` true in the non-omp case).
- **Token-gap test:** mock `model: { contextWindow: 4000 }` → gap = 1000 tokens; chars/4 estimate (5000 chars = 1250 tokens triggers re-inject; 1 token does not).
- **Conventions:** `mkdtempSync("claude-rules-")` per test in `beforeEach`, `rmSync` in `afterAll`; `discover.test.ts` calls `clearRuleCache()` in `beforeEach`.
- **When changing behavior,** update the matching `context.test.ts` assertions — the injected `<instructions>` message must be appended last, start/end with the tags, and lead with `Contents of <absolute path>:`.

## DSH Profile Patch Format

When editing `cordis.patch.yml` for a DSH profile, entries are loader patch
entries, not raw composition rows. There are two forms:

1. **Override an existing entry** — match by `id`:
   ```yaml
   - id: existing-row-id
     config:
       key: value
   ```
   Silently does nothing if the `id` does not exist in the base composition.

2. **Insert a new row** — wrap in an `insert:` block:
   ```yaml
   - insert:
       - id: my-new-plugin
         name: '@scope/package'
         config:
           key: value
   ```
   This is the only way to add a new plugin row. Use `dsh --profile <name> --dump-config | grep <id>` to verify the row appears.

A bare `- id: ...` without `insert:` is always an **override** — it will not
add a new row, and the loader warns "patch: entry \<id\> not found" without
failing.