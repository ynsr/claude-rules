# claude-rules

Injects Claude Code `.claude/rules/*.md` rules into omp / Pi based on the `paths`
frontmatter property. When the session touches a file matching a rule's `paths`,
that rule's content is injected into the system prompt (start of turn) and, as
user-role `<instructions>` content alongside the tool result that matched
(mid-session, like Claude Code).

## Why

Claude Code supports `.claude/rules/*.md` files with `paths` frontmatter that scope
rules to matching files. omp and Pi read `.claude/CLAUDE.md` but not
`.claude/rules/*.md`. This extension closes that gap.

## Install

The extension is split across modules (`src/discover.ts`, `match.ts`, `format.ts`,
`rule.ts`, `glob.ts`). It cannot be installed by copying `src/index.ts` alone —
its relative imports would fail to resolve outside the repo.

**Option A — reference the source path directly (recommended).** No copy needed;
relative imports resolve within the repo. Via `config.yml`:

```yaml
extensions:
  - /path/to/claude-rules/src/index.ts
```

**Option B — bundle to a single self-contained file** for a drop-in copy:

```bash
bun build src/index.ts --target=bun --outfile=claude-rules.ts
cp claude-rules.ts ~/.omp/agent/extensions/   # or ~/.pi/agent/extensions/
```

The bundle inlines the sibling modules, so `~/.omp/agent/extensions/claude-rules.ts`
loads on its own.

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
