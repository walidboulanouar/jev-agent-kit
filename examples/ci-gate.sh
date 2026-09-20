#!/usr/bin/env bash
# Block a commit when the staged diff may contain a secret. Fails closed:
# an API error, a missing key, a missing jev binary or a git error all block.
# Usage: ci-gate.sh   (run inside a git repo)
# The diff is sent to api.typesafe.ai in 6,000 byte pieces, and each piece is checked.
set -uo pipefail
diff="$(git diff --cached)" || { echo "jev: git diff failed. Blocking." >&2; exit 1; }
[ -z "$diff" ] && exit 0
tmp="$(mktemp -d)" || exit 1
trap 'rm -rf "$tmp"' EXIT
printf '%s' "$diff" | split -b 6000 - "$tmp/piece." || { echo "jev: could not split the diff. Blocking." >&2; exit 1; }
for piece in "$tmp"/piece.*; do
  jev check "Does this diff add a password, API key or private token?" -t 0.8 --file "$piece" >/dev/null
  rc=$?
  case "$rc" in
    1) ;;                                                          # judged: no secret in this piece
    0) echo "jev: the diff may contain a secret" >&2; exit 1 ;;   # judged: secret
    *) echo "jev: could not check the diff (exit $rc). Blocking." >&2; exit 1 ;;
  esac
done
exit 0
