#!/usr/bin/env bash
# Usage: compact-run.sh "what you are working on" command [args...]
# Runs the command, prints only the useful lines, exits with the command's exit code.
set -uo pipefail
JEV="${JEV:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/jev.js}"
task="${1:?usage: compact-run.sh \"task\" command [args...]}"; shift
[ "$#" -gt 0 ] || { echo "no command given" >&2; exit 3; }
tmp="$(mktemp)"; trap 'rm -f "$tmp"' EXIT
"$@" > "$tmp" 2>&1
code=$?
if [ ! -s "$tmp" ]; then exit "$code"; fi
$JEV compact "$task" --file "$tmp" || echo "jev: compaction failed, showing the last 40 lines" >&2 && tail -n 40 "$tmp" >&2
exit "$code"
