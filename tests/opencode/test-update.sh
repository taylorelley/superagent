#!/usr/bin/env bash
# Test: Superagent update checker and installer
# Pure unit tests — no OpenCode binary, network, or child process required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Test: Superagent update checker ==="

node --test "$SCRIPT_DIR/test-update-check.mjs"
node --test "$SCRIPT_DIR/test-update-install.mjs"

echo ""
echo "=== All update-check tests passed ==="
