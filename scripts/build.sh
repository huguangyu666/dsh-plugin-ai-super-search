#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
rm -rf lib
mkdir -p lib
cp src/*.js lib/
node --test test/*.test.mjs
