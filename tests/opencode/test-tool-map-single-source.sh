#!/usr/bin/env bash
# Test: the OpenCode tool mapping has exactly one source of truth
#
# The mapping used to be restated in the plugin, INSTALL.md, and
# docs/README.opencode.md. This fails if the generated doc regions drift from
# .opencode/lib/tool-map.js.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Test: tool map single source ==="

if node "$REPO_ROOT/scripts/sync-tool-map.mjs" --check; then
    echo "  [PASS] Generated tool-map regions match .opencode/lib/tool-map.js"
else
    echo "  [FAIL] Tool map has drifted; run scripts/sync-tool-map.sh"
    exit 1
fi

# The OpenCode mapping must not be hand-written anywhere else. A stray bullet
# list is exactly the drift this test exists to prevent.
opencode_docs=$(find "$REPO_ROOT/.opencode" -name '*.md'; echo "$REPO_ROOT/docs/README.opencode.md")
strays=""
while IFS= read -r doc; do
    [ -f "$doc" ] || continue
    # A mapping bullet outside the generated region.
    if awk '/BEGIN GENERATED TOOL MAP/{skip=1} /END GENERATED TOOL MAP/{skip=0; next} !skip' "$doc" \
        | grep -q 'apply_patch`$'; then
        strays="$strays $doc"
    fi
done <<< "$opencode_docs"

if [ -n "$strays" ]; then
    echo "  [FAIL] Hand-written OpenCode tool mapping still present in:$strays"
    exit 1
fi
echo "  [PASS] No hand-written copies of the OpenCode mapping remain"

echo ""
echo "=== Tool map single-source test passed ==="
