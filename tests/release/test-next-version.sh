#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SCRIPT_SOURCE="$REPO_ROOT/scripts/next-version.sh"
TEST_ROOT="$(mktemp -d)"

cleanup() {
  rm -rf "$TEST_ROOT"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

# make_repo creates a git repository with the script and a package.json at
# the given version, then tags its single commit with each remaining argument.
make_repo() {
  local repo="$1" version="$2"
  shift 2
  mkdir -p "$repo/scripts"
  cp "$SCRIPT_SOURCE" "$repo/scripts/next-version.sh"
  printf '{\n  "name": "fixture",\n  "version": "%s"\n}\n' "$version" >"$repo/package.json"
  git -C "$repo" init -q
  git -C "$repo" -c user.name=t -c user.email=t@example.com add -A
  git -C "$repo" -c user.name=t -c user.email=t@example.com commit -qm init
  local tag
  for tag in "$@"; do
    git -C "$repo" tag "$tag"
  done
}

expect() {
  local name="$1" repo="$2" date="$3" want="$4" got
  got="$(RELEASE_DATE="$date" /bin/bash "$repo/scripts/next-version.sh")"
  [[ "$got" == "$want" ]] || fail "$name: expected '$want', got '$got'"
  echo "ok - $name"
}

make_repo "$TEST_ROOT/fresh" 0.1.0
expect "first release of a month starts at .0" "$TEST_ROOT/fresh" 2026-11 2026.11.0
expect "month is not zero-padded" "$TEST_ROOT/fresh" 2026-03 2026.3.0

make_repo "$TEST_ROOT/tagged" 2026.11.1 v2026.11.0 v2026.11.1 v2026.10.7 v1.2.3
expect "continues from this month's highest tag" "$TEST_ROOT/tagged" 2026-11 2026.11.2
expect "a new month resets the counter" "$TEST_ROOT/tagged" 2026-12 2026.12.0

make_repo "$TEST_ROOT/numeric" 0.1.0 v2026.11.2 v2026.11.10 v2026.11.9
expect "counter compares numerically, not lexically" "$TEST_ROOT/numeric" 2026-11 2026.11.11

make_repo "$TEST_ROOT/untagged" 2026.11.4
expect "package.json counts when no tag is ahead of it" "$TEST_ROOT/untagged" 2026-11 2026.11.5

make_repo "$TEST_ROOT/lookalike" 0.1.0 v2026.1.5 v2026.11.0-rc
expect "other months and suffixed tags are ignored" "$TEST_ROOT/lookalike" 2026-11 2026.11.0

if RELEASE_DATE=2026-13 /bin/bash "$TEST_ROOT/fresh/scripts/next-version.sh" >/dev/null 2>&1; then
  fail "an out-of-range month was accepted"
fi
if RELEASE_DATE=26-11 /bin/bash "$TEST_ROOT/fresh/scripts/next-version.sh" >/dev/null 2>&1; then
  fail "a malformed RELEASE_DATE was accepted"
fi
echo "ok - malformed RELEASE_DATE is rejected"

echo "All next-version tests passed."
