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
