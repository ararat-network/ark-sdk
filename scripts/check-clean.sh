#!/bin/sh
# Fails when any of the given paths differs from what is committed: a changed,
# added, or removed file alike. `git diff --exit-code` misses an untracked
# addition, so a proto or fixture that appeared would pass it. Prints what
# differs.
set -eu

cd "$(dirname "$0")/.."
status=$(git status --porcelain -- "$@")
if [ -n "$status" ]; then
  echo "$status"
  echo "the paths above differ from what is committed" >&2
  exit 1
fi
