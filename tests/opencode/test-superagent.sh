#!/usr/bin/env bash
# Test: Superagent layer (config, roster, prompts, routing)
# Pure unit tests — no OpenCode binary required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Test: Superagent layer ==="

node --test "$SCRIPT_DIR/test-superagent.mjs"

echo ""
echo "=== All Superagent unit tests passed ==="
