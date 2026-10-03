#!/usr/bin/env bash
# Build and install claude-rules-for-omp (omp bundle) and wire the DSH plugin
# (source path) into DSH profiles.
#
# Usage:
#   ./install.sh                 # build omp bundle, install, patch web+lite profiles
#   ./install.sh --check         # dry run: print what would change, change nothing
#   ./install.sh --profiles web  # only patch the web profile (repeatable, comma-separated)
#   ./install.sh --skip-build    # skip `bun run build:omp` (reuse existing bundle)
#   ./install.sh --skip-dsh      # omp bundle only, do not touch DSH profiles
#
# Idempotent: re-running produces the same result (bundle overwritten with a
# fresh build; the cordis.patch.yml row is added only if no dsh-rules entry
# already exists in that file).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OMP_EXT_DIR="$HOME/.omp/agent/extensions"
BUNDLE="$REPO_DIR/claude-rules-for-omp.ts"
PLUGIN_SRC="$REPO_DIR/src/dsh/plugin.ts"
PROFILES="${PROFILES:-web,lite}"
SKIP_BUILD=0
SKIP_DSH=0
CHECK=0

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --skip-dsh) SKIP_DSH=1; shift ;;
    --profiles) PROFILES="${2:?--profiles needs a value}"; shift 2 ;;
    --profiles=*) PROFILES="${1#--profiles=}"; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown flag $1 (see --help)" >&2; exit 1 ;;
  esac
done

run() {
  if [ "$CHECK" -eq 1 ]; then
    printf '[check] %s\n' "$*"
  else
    "$@"
  fi
}

if [ "$SKIP_BUILD" -eq 0 ]; then
  run bash -c "cd \"\$0\" && bun run build:omp" "$REPO_DIR"
else
  [ -f "$BUNDLE" ] || { echo "install.sh: bundle missing: $BUNDLE (run without --skip-build)" >&2; exit 1; }
  echo "install.sh: reusing existing bundle $BUNDLE"
fi

run mkdir -p "$OMP_EXT_DIR"
run cp "$BUNDLE" "$OMP_EXT_DIR/claude-rules-for-omp.ts"
echo "install.sh: omp bundle -> $OMP_EXT_DIR/claude-rules-for-omp.ts"

# 2. DSH profiles --------------------------------------------------------------
if [ "$SKIP_DSH" -eq 0 ]; then
  # Split comma-separated profile list without glob-expanding entries.
  profiles="$PROFILES"
  old_ifs="$IFS"
  IFS=','
  # shellcheck disable=SC2162
  read -ra PROFILE_LIST <<< "$profiles" || true
  IFS="$old_ifs"
  for profile in "${PROFILE_LIST[@]}"; do
    # Trim surrounding whitespace from the profile name.
    profile="$(printf '%s' "$profile" | tr -d '[:space:]')"
    [ -n "$profile" ] || continue
    patch="$HOME/.dsh/profiles/$profile/cordis.patch.yml"
    if [ ! -f "$patch" ]; then
      echo "install.sh: skip missing profile patch: $patch" >&2
      continue
    fi
    if grep -q 'id: dsh-rules' "$patch"; then
      # Repo was renamed claude-rules -> claude-rules-for-omp: repoint a stale
      # source path instead of adding a duplicate row.
      if grep -q 'claude-rules/src/dsh/plugin.ts' "$patch"; then
        if [ "$CHECK" -eq 1 ]; then
          printf '[check] repoint stale dsh-rules path in %s\n' "$patch"
        else
          sed -i "s|claude-rules/src/dsh/plugin.ts|claude-rules-for-omp/src/dsh/plugin.ts|g" "$patch"
          echo "install.sh: [$profile] dsh-rules path repointed -> $patch"
        fi
      else
        echo "install.sh: [$profile] dsh-rules row already present, leaving untouched"
      fi
      continue
    fi
    if [ "$CHECK" -eq 1 ]; then
      printf '[check] append dsh-rules insert block to %s\n' "$patch"
      continue
    fi
    cat >> "$patch" <<EOF

# Path-scoped rules from .dsh/rules/*.md and .claude/rules/*.md
- insert:
    - id: dsh-rules
      name: '$PLUGIN_SRC'
      config:
        maxBytes: 65536
EOF
    echo "install.sh: [$profile] dsh-rules row appended -> $patch"
  done
fi

echo "install.sh: done. Restart omp sessions / reload DSH profiles to pick up the change."
