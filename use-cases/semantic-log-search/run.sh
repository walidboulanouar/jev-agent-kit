#!/usr/bin/env bash
set -uo pipefail
JEV="${JEV:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/jev.js}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "== jev grep: problems with the database"
$JEV grep "problems with the database" -t 0.5 --file "$here/sample/server.log"
echo
echo "== grep, then compact for an agent fixing failed writes"
$JEV grep "problems with the database" -t 0.5 --raw --file "$here/sample/server.log" | $JEV compact "find why database writes failed" --around 0
