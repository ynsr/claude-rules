# Changelog

All notable changes to this project are documented here.

## [Unreleased]

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
