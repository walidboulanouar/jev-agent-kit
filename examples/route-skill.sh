#!/usr/bin/env bash
# Pick which skill folder to load for a task. Usage: route-skill.sh "task text" [skills-dir]
# Exits 0 with the skill name, 1 when nothing fits, 3 on error.
set -uo pipefail
task="${1:?usage: route-skill.sh \"task text\" [skills-dir]}"
dir="${2:-skills}"
args=()
for f in "$dir"/*/SKILL.md; do
  [ -e "$f" ] || continue
  name="$(basename "$(dirname "$f")")"
  [ "$name" = "none" ] && continue   # "none" is reserved by jev route
  desc="$(grep -m1 '^description:' "$f" | cut -d: -f2- | cut -c1-200)"
  [ -z "${desc// /}" ] && continue
  args+=(-c "$name=$desc")
done
if [ "${#args[@]}" -eq 0 ]; then echo "no skills found in $dir" >&2; exit 3; fi
jev route "$task" "${args[@]}"
