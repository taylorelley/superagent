#!/usr/bin/env bash
# Unit checks always run. --integration requires a real Codex binary.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--integration" ) ]]; then
    echo "Usage: bash tests/codex/run-tests.sh [--integration]" >&2
    exit 2
fi
node --test tests/codex/*.test.mjs
if [[ "${1:-}" == "--integration" || "${REQUIRE_CODEX:-0}" == "1" ]]; then
    if ! command -v codex >/dev/null 2>&1; then
        echo "error: native integration requires codex on PATH" >&2
        exit 1
    fi
    node tests/codex/native.mjs
else
    echo "Native Codex integration not requested; run with --integration."
fi
