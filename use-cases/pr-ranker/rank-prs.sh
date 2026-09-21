#!/usr/bin/env bash
# Usage: some-command-that-prints-pr-titles | rank-prs.sh [--top N]
set -uo pipefail
JEV="${JEV:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/jev.js}"
$JEV rank "how urgently this pull request needs a reviewer, counting security problems and production outages as most urgent and cosmetic changes as least urgent" "$@"
