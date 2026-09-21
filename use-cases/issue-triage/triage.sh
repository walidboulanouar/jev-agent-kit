#!/usr/bin/env bash
# Usage: some-command-that-prints-titles | triage.sh
set -uo pipefail
JEV="${JEV:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/jev.js}"
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
$JEV triage \
  -o bug="something is broken, crashes or returns an error" \
  -o question="someone asks how to do something" \
  -o feature="a request for new behavior" \
  -o docs="a problem with documentation or wording" > "$tmp" || exit $?
cat "$tmp"
echo
echo "counts:"
cut -f1 "$tmp" | sort | uniq -c | sort -rn
