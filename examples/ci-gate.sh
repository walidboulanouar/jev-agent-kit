#!/usr/bin/env bash
# Fail a CI step when a diff looks like it leaks a secret. Usage: git diff | ci-gate.sh
set -uo pipefail
if git diff --cached | jev check "Does this diff add a password, API key or private token?" -t 0.8 >/dev/null; then
  echo "jev: the diff may contain a secret" >&2
  exit 1
fi
