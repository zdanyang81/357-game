#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
node --test tests/*.test.js
node test.js
node test-race.js
node test-avatar.js
node scripts/check-minigame.js
git diff --check
