#!/usr/bin/env bash
# Test: Plugin Loading
# Verifies that the superagent plugin loads correctly in OpenCode
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== Test: Plugin Loading ==="

# Source setup to create isolated environment
source "$SCRIPT_DIR/setup.sh"

# Trap to cleanup on exit
trap cleanup_test_env EXIT

plugin_link="$OPENCODE_CONFIG_DIR/plugins/superagent.js"

# Test 1: Verify plugin file exists and is registered
echo "Test 1: Checking plugin registration..."
if [ -L "$plugin_link" ]; then
    echo "  [PASS] Plugin symlink exists"
else
    echo "  [FAIL] Plugin symlink not found at $plugin_link"
    exit 1
fi

# Verify symlink target exists
if [ -f "$(readlink -f "$plugin_link")" ]; then
    echo "  [PASS] Plugin symlink target exists"
else
    echo "  [FAIL] Plugin symlink target does not exist"
    exit 1
fi

# Test 2: Verify skills directory is populated
echo "Test 2: Checking skills directory..."
skill_count=$(find "$SUPERAGENT_SKILLS_DIR" -name "SKILL.md" | wc -l)
if [ "$skill_count" -gt 0 ]; then
    echo "  [PASS] Found $skill_count skills"
else
    echo "  [FAIL] No skills found in $SUPERAGENT_SKILLS_DIR"
    exit 1
fi

# Test 3: Check using-superagent skill exists (critical for bootstrap)
echo "Test 3: Checking using-superagent skill (required for bootstrap)..."
if [ -f "$SUPERAGENT_SKILLS_DIR/using-superagent/SKILL.md" ]; then
    echo "  [PASS] using-superagent skill exists"
else
    echo "  [FAIL] using-superagent skill not found (required for bootstrap)"
    exit 1
fi

# Test 4: Verify JavaScript syntax across every plugin source file.
# The plugin is multi-file, so checking only the entry point would leave the
# modules it imports unverified.
echo "Test 4: Checking plugin JavaScript syntax..."
js_files=$(find "$SUPERAGENT_DIR/.opencode" -name '*.js' | sort)
if [ -z "$js_files" ]; then
    echo "  [FAIL] No plugin JavaScript files found"
    exit 1
fi
while IFS= read -r js_file; do
    if ! node --check "$js_file" 2>/dev/null; then
        echo "  [FAIL] Syntax error in ${js_file#"$SUPERAGENT_DIR/"}"
        exit 1
    fi
done <<< "$js_files"
echo "  [PASS] JavaScript syntax is valid in $(echo "$js_files" | wc -l) file(s)"

# Test 4b: The entry point must stay a wiring shim. Logic belongs in lib/,
# where it is unit testable without an OpenCode binary.
echo "Test 4b: Checking entry point stays thin..."
entry_lines=$(wc -l < "$SUPERAGENT_PLUGIN_FILE")
if [ "$entry_lines" -gt 200 ]; then
    echo "  [FAIL] Entry point is $entry_lines lines; move logic into .opencode/lib/"
    exit 1
fi
echo "  [PASS] Entry point is $entry_lines lines"

# Test 4c: The plugin must actually load and expose its hooks. This is the
# real regression net for the multi-file split — a broken relative import
# passes `node --check` but fails at import time.
echo "Test 4c: Checking plugin module loads and exports hooks..."
if ! node "$SCRIPT_DIR/test-plugin-exports.mjs" "$SUPERAGENT_PLUGIN_FILE"; then
    echo "  [FAIL] Plugin did not load or is missing expected hooks"
    exit 1
fi
echo "  [PASS] Plugin loads and exposes config + messages transform hooks"

# Test 5: Verify bootstrap text does not reference a hardcoded skills path
echo "Test 5: Checking bootstrap does not advertise a wrong skills path..."
if grep -rq 'configDir}/skills/superagent/' "$SUPERAGENT_DIR/.opencode"; then
    echo "  [FAIL] Plugin still references old configDir skills path"
    exit 1
else
    echo "  [PASS] Plugin does not advertise a misleading skills path"
fi

# Test 6: Verify personal test skill was created
echo "Test 6: Checking test fixtures..."
if [ -f "$OPENCODE_CONFIG_DIR/skills/personal-test/SKILL.md" ]; then
    echo "  [PASS] Personal test skill fixture created"
else
    echo "  [FAIL] Personal test skill fixture not found"
    exit 1
fi

echo ""
echo "=== All plugin loading tests passed ==="
