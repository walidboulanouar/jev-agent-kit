#!/usr/bin/env bash
set -uo pipefail
JEV="${JEV:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/jev.js}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
while IFS= read -r payload; do
  cmd="$(printf '%s' "$payload" | sed -E 's/.*"command":"([^"]*)".*/\1/')"
  out="$(printf '%s' "$payload" | $JEV guard --hook 2>/dev/null)"
  if [ -z "$out" ]; then
    printf '%-64s -> (nothing, normal permission flow)\n' "$cmd"
  else
    printf '%-64s -> %s\n' "$cmd" "$(printf '%s' "$out" | sed -E 's/.*"permissionDecision":"([a-z]+)".*"permissionDecisionReason":"([^"]*)".*/\1: \2/')"
  fi
done < "$here/sample/payloads.jsonl"
