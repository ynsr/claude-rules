# Changelog

All notable changes to this project are documented here.

## [Unreleased]

### Added
- `install.sh`: one-command build + install for both hosts — rebuilds the omp
  bundle into `~/.omp/agent/extensions/`, ensures the `dsh-rules` source-path
  row in the web+lite `cordis.patch.yml` files (repoints the stale pre-rename
  path). Idempotent; `--check` dry-runs, `--skip-dsh` / `--profiles` narrow it.
- Guaranteed-delivery injection via `tool_result`: matching rules + nested
  `AGENTS.md` are appended as trailing `<instructions>` text on the tool result
  the model sees next (fires synchronously in the agent tool loop). Shares
  inject-once dedup, formatted cache, and section rendering with the `context`
  path. Known gap: a turn where the model answers an `@path` mention without
  calling any tool injects nothing — no hook fires on that path.

### Changed
- Renamed package to `claude-rules-for-omp` (omp factory `claudeRulesForOmp`,
  `claudeRules` kept as alias); DSH plugin stays `dsh-rules` / `dsh-rules.ts`.
- Rule injection is now inject-once per session: context growth (including +70K
  tokens) never re-injects. Re-discovery + cache clear happens only on
  compaction — omp detects a >30% token drop (minimum 5K tokens); DSH honors
  explicit compaction signals (matched defensively on
  `/compact|summar|prune/i`) since growth alone is not observable there.
- Nested `AGENTS.md` support (Claude-Code style, dir-scoped, root → leaf with
  leaf last). The file at the session cwd is skipped (harness-owned).
- Split bundles with host-provided externals: `bun run build:omp` →
  `claude-rules-for-omp.ts` (~8KB, `@earendil-works/pi-coding-agent`
  external, types-only at runtime); `bun run build:dsh` → `dsh-rules.ts`
  (~30KB, `@deepseek-ai/cordis` / `@deepseek-ai/dsh-llm` external). Replaces
  the old 10.9MB single-file `claude-rules.ts`.
