#!/usr/bin/env bash
# Usage: route-skill.sh "task text" [skills-dir]
# Prints the skill name. Exit 0 = a skill fits, 1 = none fits, 3 = error.
set -uo pipefail
JEV="${JEV:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/jev.js}"
task="${1:?usage: route-skill.sh \"task\" [skills-dir]}"
dir="${2:-skills}"
args=()
for f in "$dir"/*/SKILL.md; do
  [ -e "$f" ] || continue
  name="$(basename "$(dirname "$f")")"
  [ "$name" = "none" ] && continue
  desc="$(grep -m1 '^description:' "$f" | cut -d: -f2- | cut -c1-200)"
  [ -z "${desc// /}" ] && continue
  args+=(-c "$name=$desc")
done
if [ "${#args[@]}" -eq 0 ]; then echo "no skills found in $dir" >&2; exit 3; fi
$JEV route "$task" "${args[@]}"
