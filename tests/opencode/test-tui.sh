#!/usr/bin/env bash
# Test: Superagent TUI sidebar panel
# Pure unit tests — no OpenCode binary required.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Test: Superagent TUI panel ==="

node --test "$SCRIPT_DIR/test-tui-snapshot.mjs"
node --test "$SCRIPT_DIR/test-tui-panel.mjs"
node --test "$SCRIPT_DIR/test-tui-entry.mjs"

echo ""
echo "=== All TUI panel tests passed ==="
