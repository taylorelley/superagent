#!/usr/bin/env bash
# Claude Code plugin test suite.
#
#   1. Node unit tests for the pure modules (always run).
#   2. `claude plugin validate` and `claude plugin test`, which load the hooks
#      module in Claude Code's own engine. These need the `claude` CLI (no
#      sign-in, no network); without it they are skipped, unless
#      REQUIRE_CLAUDE=1, which CI sets so a missing CLI fails loudly.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

echo "========================================"
echo " Claude Code Plugin Test Suite"
echo "========================================"

status=0

echo ""
echo "--- Unit tests (node --test)"
if ! node --test tests/claude-code/test-claude-code.mjs; then
    status=1
fi

if command -v claude >/dev/null 2>&1; then
    echo ""
    echo "--- claude plugin validate ($(claude --version))"
    if validate_output=$(claude plugin validate . 2>&1); then
        printf '%s\n' "$validate_output" | grep -E '^\s*>\s.*(hooks|calls|env reads):|Validation' || true
    else
        printf '%s\n' "$validate_output"
        status=1
    fi

    echo ""
    echo "--- claude plugin test"
    if ! claude plugin test; then
        status=1
    fi
elif [[ "${REQUIRE_CLAUDE:-0}" == "1" ]]; then
    echo "error: the claude CLI is required (REQUIRE_CLAUDE=1) but is not on PATH" >&2
    status=1
else
    echo ""
    echo "--- Skipped: claude plugin validate / test (the claude CLI is not on PATH)"
fi

echo ""
if [[ $status -eq 0 ]]; then
    echo "STATUS: PASSED"
else
    echo "STATUS: FAILED"
fi
exit $status
