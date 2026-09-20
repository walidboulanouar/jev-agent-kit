#!/usr/bin/env bash
# Pick which skill folder to load for a task. Usage: route-skill.sh "task text" skills-dir
set -euo pipefail
task="$1"; dir="${2:-skills}"
args=()
for f in "$dir"/*/SKILL.md; do
  name="$(basename "$(dirname "$f")")"
  desc="$(grep -m1 '^description:' "$f" | cut -d: -f2- | cut -c1-200)"
  args+=(-c "$name=$desc")
done
jev route "$task" "${args[@]}"
