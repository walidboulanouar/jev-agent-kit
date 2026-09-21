#!/usr/bin/env bash
set -uo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for task in "merge these three PDFs into one file" "why is this query doing a full table scan" "reply to the customer who asked for a refund" "book me a flight to Lisbon"; do
  printf '%-52s -> ' "$task"
  bash "$here/route-skill.sh" "$task" "$here/sample/skills"
done
exit 0
