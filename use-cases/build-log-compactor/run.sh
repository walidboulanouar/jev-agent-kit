#!/usr/bin/env bash
set -uo pipefail
JEV="${JEV:-node $(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/bin/jev.js}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "original: $(wc -l < "$here/sample/build.log" | tr -d ' ') lines"
$JEV compact "fix the TypeScript compile error in the build" --around 0 --file "$here/sample/build.log"
