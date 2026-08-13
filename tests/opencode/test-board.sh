#!/usr/bin/env bash
# Test: Superagent job board and file ownership
# Pure unit tests — no OpenCode binary required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Test: Superagent job board ==="

node --test "$SCRIPT_DIR/test-board.mjs"

echo ""
echo "=== All job board tests passed ==="
