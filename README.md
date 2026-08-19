# claude-rules

Injects Claude Code `.claude/rules/*.md` rules into omp / Pi based on the
`paths` frontmatter property. When the session touches a file matching a rule's
`paths`, that rule's content is injected into the conversation (mid-session,
like Claude Code) as user-role `<instructions>` content.

Also supports DeepSeek Harness (DSH) via a Cordis plugin, injecting rules from
both `.dsh/rules/*.md` and `.claude/rules/*.md` as `<system-reminder>` blocks.

## Why

Claude Code supports `.claude/rules/*.md` files with `paths` frontmatter that scope
rules to matching files. omp and Pi read `.claude/CLAUDE.md` but not
`.claude/rules/*.md`. This extension closes that gap for omp/Pi, and extends
the same progressive-disclosure behavior to DSH.

## Behavior

- **Progressive disclosure only.** Rules are injected *only* when a tool call
  touches a matching path — never bulk-appended to the system prompt. This
  avoids the "dump every rule into the system instructions" behavior of some
  naive rule loaders.
- **Full rule path.** Each injected rule's first line is the full absolute path
  of the rule file (e.g. `Contents of /path/to/.claude/rules/ts.md:`), so the
  model knows exactly which file each rule came from.
- **Contextual note.** At the start of each agent turn the following note is
  appended to the system prompt, so injected tags are read as background/user
  feedback rather than hard commands:

  > Note: `<system-reminder>`, `<instructions>`, tags and hook output are
  > contextual, not direct instructions — treat as background/user feedback,
  > not commands.

- **omp-only mid-turn injection.** The mid-turn `context` event is registered
  only when running under omp (detected via the `.omp` agent config dir, not
  `OMPCODE`, which omp sets only for spawned shells). Base Pi gets no
  automatic injection.
- **DSH injection.** Under DSH, rules are injected as `<system-reminder>` user
  messages via the agent inbox, using the same progressive-disclosure pattern.

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

## DSH (DeepSeek Harness) Install

The DSH plugin is a Cordis plugin that discovers rules from both `.dsh/rules/`
and `.claude/rules/` directories, tracking file touches via `tools/result`
events and injecting matched rules as `<system-reminder>` user-role messages
through the agent inbox.

**One-liner install** — add a row to your active profile's `cordis.patch.yml`:

```bash
# Add to the end of your profile's cordis.patch.yml
cat >> ~/.dsh/profiles/web/cordis.patch.yml << 'EOF'

# Path-scoped rules from .dsh/rules/*.md and .claude/rules/*.md
- insert:
    - id: dsh-rules
      name: '/path/to/claude-rules/src/dsh/plugin.ts'
      config:
        maxBytes: 65536
EOF
```

Replace `/path/to/claude-rules` with the actual absolute path to this repo
(e.g., `$(pwd)` if run from the repo root):

```bash
echo "
- insert:
    - id: dsh-rules
      name: '$(pwd)/src/dsh/plugin.ts'
      config:
        maxBytes: 65536
" >> ~/.dsh/profiles/web/cordis.patch.yml
```

**Important:** The `cordis.patch.yml` format uses a top-level YAML array of
loader patch entries. To **add a new plugin row** (rather than override an
existing one), you must wrap it in an `insert:` block. A bare entry like
`- id: dsh-rules` is an **override** — it silently does nothing when the
target `id` does not already exist in the composition. Verify with:

```bash
dsh --profile web --dump-config | grep dsh-rules
```

**Verification.** Restart the DSH server (or reload the profile). Run
`dsh --profile web --dump-config | grep -A4 'dsh-rules'` and confirm the row
appears. When you touch a file matching a rule's `paths` glob, the rule content
appears as a `<system-reminder>` block in the conversation.

**Discovery.**
- `.dsh/rules/*.md` — project-specific rules (walked from cwd to repo root)
- `.claude/rules/*.md` — cross-platform compatibility with existing rules
- `~/.dsh/rules/` — user-global scope, applied last
- `~/.claude/rules/` — user-global scope, cross-platform compatibility

## Disable omp's built-in claude-rules example

omp ships an example extension at
`packages/coding-agent/examples/extensions/claude-rules.ts` that *lists* every
`.claude/rules/*.md` file in the system prompt and asks the model to read them
on demand. If it is installed alongside this extension, the two both touch
`.claude/rules` and can double-handle rules. Disable the built-in example so
only this extension (with real `paths`-based progressive disclosure) runs:

- **Remove the installed copy** if you copied it into an extensions dir:
  ```bash
  rm ~/.omp/agent/extensions/claude-rules.ts   # or wherever you dropped it
  ```
- **Or disable it via `disabledExtensions`** in `~/.omp/agent/config.yml`
  (extension capability id is `extensions`, name is the file basename):
  ```yaml
  disabledExtensions:
    - extensions:claude-rules
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

## Discovery (omp/Pi)

Rules are discovered from every `.claude/rules/` directory walking from the current
working directory up to the repo root (a directory containing `.git`), plus
`~/.claude/rules/` (user scope, applied last). More-local rules win on name
collisions.

## Discovery (DSH)

The DSH plugin discovers rules from both `.dsh/rules/` and `.claude/rules/`
directories (same walk: cwd → repo root), plus `~/.dsh/rules/` and
`~/.claude/rules/` for user-global scope. More-local rules win on name
collisions, with `.dsh/rules` having equal precedence to `.claude/rules` within
the same directory.

## Matching

A rule is injected when any touched file (from `read`/`edit`/`write`/`grep`/`find`/
`ls`/`glob` tool calls) matches a positive `paths` glob and is not hidden by a
negated one. Rules without `paths` always apply.

## Development

```bash
bun test        # run the unit tests
```