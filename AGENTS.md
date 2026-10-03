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
| `src/` | Extension source. `index.ts` (entry/factory `claudeRulesForOmp`), `discover.ts` (rule discovery + cache), `agents.ts` (nested AGENTS.md discovery + scope match), `match.ts` (path match), `format.ts` (rendering), `rule.ts` (Rule type + frontmatter parsing), `glob.ts` (dependency-free glob matcher) |
| `test/` | `bun:test` unit + integration tests, one file per module plus `context.test.ts` (integration) |
| `.claude/rules/` | Dogfood rules shipped with the repo (`ts-style.md`, `api-design.md`, `security.md`) — they exercise the extension's own `paths` matching |
| `docs/superpowers/plans/` | Implementation plan (historical artifact; its architecture section is stale — see below) |

## Development Commands

```bash
bun test                          # run the test suite (bun:test)
bun x tsc --noEmit                # typecheck (strict, noEmit; not scripted in package.json)
bun run build:omp                 # → claude-rules-for-omp.ts (external: pi-coding-agent, types-only)
bun run build:dsh                 # → dsh-rules.ts (external: cordis, dsh-llm)
cp claude-rules-for-omp.ts ~/.omp/agent/extensions/   # install as drop-in copy (Option B)
```

- Install Option A (recommended): reference `src/index.ts` directly via `config.yml` `extensions:` — no bundle needed; relative imports resolve in-repo.
- Install Option B: bundle to a single self-contained file (relative imports would otherwise fail outside the repo).

## Code Conventions & Common Patterns

- **ESM** (`"type": "module"`), factory-export style: `export default function claudeRulesForOmp(pi: ExtensionAPI)` (`claudeRules` alias kept for existing installs).
- **Type-only imports** from `@earendil-works/pi-coding-agent` (real dependency, `^0.84.1`, but types-only at runtime — the omp bundle externalizes it and uses a local chars/4 token estimate). DSH imports `@deepseek-ai/cordis`/`@deepseek-ai/dsh-llm` as host-provided externals (never bundled).
- **Never throw in parsers.** `parseFrontmatter`, `stripFrontmatter`, `globToRegExp` all degrade gracefully on malformed input (return empty metadata / literals). No empty try/catch; unreadable files skip via guarded try/catch.
- **Dependency-free primitives.** Glob translation and YAML-frontmatter parsing are hand-rolled in `glob.ts` / `rule.ts` — extend them in place rather than adding libraries.
- **AGENTS.md scope** (in `agents.ts`): `discoverAgents` walks repoRoot → cwd, returns root→leaf docs, skips the file at cwd (harness-owned); `matchAgent` checks touched path under `scopeDir`; mtime-keyed cache via `clearAgentCache`.
- **Inject-once + compaction:** `injectedEver` set per session; growth never re-injects; re-discovery + clear only on token-drop compaction (>30% and >5K tokens; DSH also honors explicit compaction events). Cached formatted bodies in `formattedCache`.
- **Per-path negation semantics** (in `matchRule`): a touched path must match a positive glob AND not be hidden by a negated glob; other negated touched paths don't disqualify.
- **`alwaysApply`** = `paths.length === 0` (after `!`-prefixed entries are split into `negated`).
- **omp detection** (`isOmp`): check `OMPCODE === "1"` fast path, then scan `PI_CODING_AGENT_DIR`/`PI_CONFIG_DIR` for an `.omp` segment. `OMPCODE` alone is unreliable (set only in spawned shells, not the extension host).
- **Logging:** structured `ctx.logger` (falls back to `console.warn` in tests/mocks); module-load line uses `console.warn` before any ctx exists. No UI toasts.
- **Naming:** module files lowercase single-word (`match.ts`, `discover.ts`); rule discovery uses `{ name }` = filename minus `.md`/`.mdc`.

## Important Files

- `src/index.ts` — entry point + `claudeRulesForOmp` factory; all event wiring; constants `COMPACTION_RATIO`/`COMPACTION_MIN_TOKENS`, `CONTEXT_NOTE`; helpers `isOmp`, `contentKey`, `adoptLogger`, `capturePath`, `estimateTokensLocal`.
- `src/rule.ts` — `Rule` interface and frontmatter parsing; the source of truth for rule shape.
- `src/agents.ts` — `AgentDoc`, `discoverAgents` (root→leaf, skips cwd file), `matchAgent`, `clearAgentCache`.
- `src/match.ts` — `normalizePath`, `matchRule` (per-path negation).
- `src/glob.ts` — `globToRegExp`, `matchGlob` (segments, `**`, `?`, `{a,b}`, `[abc]`/`[a-z]`).
- `src/format.ts` — `formatRules` (`Contents of <absolute path>:` heading per rule).
- `test/context.test.ts` — integration tests; home of `makePi`, `withOmp`, `makeRepo`, `asHookResult`, `isInstructionsMessage` helpers.

## Runtime/Tooling Preferences

- **Runtime:** Bun (required — `bun:test`, `Bun.env`, `bun build`). Not Node.
- **Package manager:** `bun` (lockfile `bun.lock`).
- **Typecheck:** `bun x tsc --noEmit` (strict, `types: ["bun"]`, `moduleResolution: bundler`).
- **Extension type source:** `@earendil-works/pi-coding-agent` (dependency, `^0.84.1`, types-only at runtime).
- **Deploy artifacts:** `claude-rules-for-omp.ts` (omp) and `dsh-rules.ts` (DSH) are gitignored bun build outputs, not source.

## Testing & QA

- **Framework:** `bun:test`; run with `bun test`. No coverage tooling configured.
- **Structure:** pure-unit tests per module (`glob`, `rule`, `match`, `format`, `discover`, `agents`, `index`) test imported functions directly with hand-built fixtures; `context.test.ts` is the only integration test — it instantiates `claudeRulesForOmp` and drives the full event lifecycle through a mock pi.
- **Mock pi** (`makePi`): `Map<string, Handler[]>` registry; sequential awaited `emit` returning the last handler result. Events must fire in order `session_start → before_agent_start → tool_call → context`.
- **`withOmp(omp, fn)`** toggles BOTH `Bun.env.OMPCODE` and `PI_CODING_AGENT_DIR` (setting only `OMPCODE` would leave a real host-inherited `.omp` dir making `isOmp()` true in the non-omp case).
- **Compaction test:** inject once → growth (even +70K tokens) injects nothing → token drop >30% re-injects.
- **Conventions:** `mkdtempSync("claude-rules-for-omp-")` per test in `beforeEach`, `rmSync` in `afterAll`; `discover.test.ts` calls `clearRuleCache()` in `beforeEach`.

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