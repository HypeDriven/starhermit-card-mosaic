#!/usr/bin/env bash
# build-dist.sh — assemble the uploadable browser distribution in dist/.
# Source files, docs, tests, and runtime data stay out of the distribution.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf dist
mkdir -p dist
cp -r index.html css js vendor server.js starhermit.txt sw.js dist/
echo "dist/ ready:"
find dist -type f | sort
