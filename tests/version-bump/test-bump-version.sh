#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT_SOURCE="$REPO_ROOT/scripts/bump-version.sh"
TEST_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# make_fixture creates a repository fixture whose .version-bump.json declares
# package.json plus a second, caller-chosen manifest.
make_fixture() {
  local repo="$1"
  local extra_path="$2"
  local extra_body="$3"

  mkdir -p "$repo/scripts" "$(dirname "$repo/$extra_path")"
  cp "$SCRIPT_SOURCE" "$repo/scripts/bump-version.sh"
  cat >"$repo/.version-bump.json" <<JSON
{
  "files": [
    { "path": "package.json", "field": "version" },
    { "path": "$extra_path", "field": "plugin.version" }
  ],
  "audit": { "exclude": [] }
}
JSON
  cat >"$repo/package.json" <<'JSON'
{
  "name": "fixture",
  "version": "1.2.3"
}
JSON
  printf '%s\n' "$extra_body" >"$repo/$extra_path"
}

happy_repo="$TEST_ROOT/happy"
make_fixture "$happy_repo" ".example-plugin/plugin.json" '{ "plugin": { "version": "1.2.3" } }'

/bin/bash "$happy_repo/scripts/bump-version.sh" --check >"$TEST_ROOT/check.out"
/bin/bash "$happy_repo/scripts/bump-version.sh" --audit >"$TEST_ROOT/audit.out"
/bin/bash "$happy_repo/scripts/bump-version.sh" 2.3.4 >"$TEST_ROOT/bump.out"

[[ "$(jq -r '.version' "$happy_repo/package.json")" == "2.3.4" ]] \
  || fail "package.json was not bumped"
[[ "$(jq -r '.plugin.version' "$happy_repo/.example-plugin/plugin.json")" == "2.3.4" ]] \
  || fail "nested JSON field was not bumped"

jq -e '
  any(.files[]; .path == "package.json" and .field == "version")
' "$REPO_ROOT/.version-bump.json" >/dev/null \
  || fail "package.json is not registered for version bumps"

# An unsupported manifest format must fail preflight before any file changes.
invalid_repo="$TEST_ROOT/invalid"
make_fixture "$invalid_repo" ".example-plugin/plugin.toml" 'version = "1.2.3"'
cp "$invalid_repo/package.json" "$TEST_ROOT/package.before"
cp "$invalid_repo/.example-plugin/plugin.toml" "$TEST_ROOT/plugin.before"

if /bin/bash "$invalid_repo/scripts/bump-version.sh" 2.3.4 \
  >"$TEST_ROOT/invalid.out" 2>&1; then
  fail "bump accepted an unsupported manifest format"
fi

cmp -s "$TEST_ROOT/package.before" "$invalid_repo/package.json" \
  || fail "package.json changed before preflight failed"
cmp -s "$TEST_ROOT/plugin.before" "$invalid_repo/.example-plugin/plugin.toml" \
  || fail "unsupported manifest changed"

echo "Version-bump tests passed"
