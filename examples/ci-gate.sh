#!/usr/bin/env bash
# Block a commit when the staged diff may contain a secret. Fails closed:
# an API error, a missing key, a missing jev binary, a git error or a diff that is
# too large to check all block.
# Usage: ci-gate.sh   (run inside a git repo)
# The diff is sent to api.typesafe.ai in overlapping 6,000 byte windows (every 4,000
# bytes), so a token up to about 2,000 bytes cannot hide across a boundary. A longer
# secret, such as a large PEM key, can straddle windows and slip through. Diffs over
# 300 KB are blocked. This is a tripwire, not a full secret scanner.
set -uo pipefail
tmp="$(mktemp -d)" || exit 1
trap 'rm -rf "$tmp"' EXIT
git diff --cached > "$tmp/diff" || { echo "jev: git diff failed. Blocking." >&2; exit 1; }
size="$(wc -c < "$tmp/diff" | tr -d ' ')"
[ "$size" -eq 0 ] && exit 0
if [ "$size" -gt 300000 ]; then echo "jev: the diff is larger than 300 KB and was not checked. Blocking." >&2; exit 1; fi
off=0
while [ "$off" -lt "$size" ]; do
  tail -c +"$((off + 1))" "$tmp/diff" | head -c 6000 > "$tmp/piece"
  jev check "Does this diff add a password, API key or private token?" -t 0.8 --file "$tmp/piece" >/dev/null
  rc=$?
  case "$rc" in
    1) ;;                                                          # judged: no secret in this window
    0) echo "jev: the diff may contain a secret" >&2; exit 1 ;;   # judged: secret
    *) echo "jev: could not check the diff (exit $rc). Blocking." >&2; exit 1 ;;
  esac
  off=$((off + 4000))
done
exit 0
