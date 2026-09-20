#!/usr/bin/env bash
# Block a commit when the staged diff may contain a secret. Fails closed:
# an API error, a missing key or a missing jev binary blocks too.
# Usage: ci-gate.sh   (run inside a git repo)
# Note: the diff is sent to api.typesafe.ai. Only the first 8,000 characters
# are judged, so this is a tripwire for small diffs, not a full secret scanner.
set -uo pipefail
diff="$(git diff --cached)"
[ -z "$diff" ] && exit 0
printf '%s' "$diff" | jev check "Does this diff add a password, API key or private token?" -t 0.8 >/dev/null
rc=$?
case "$rc" in
  1) exit 0 ;;                                                 # judged: no secret
  0) echo "jev: the diff may contain a secret" >&2; exit 1 ;;  # judged: secret
  *) echo "jev: could not check the diff (exit $rc). Blocking." >&2; exit 1 ;;
esac
