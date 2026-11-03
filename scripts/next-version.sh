#!/usr/bin/env bash
#
# next-version.sh — print the next CalVer release version.
#
# Versions are YYYY.M.MICRO: the UTC year, the month without a leading zero,
# and a counter that starts at 0 each month and goes up by one per release.
# The month is unpadded because npm requires package.json versions to be valid
# semver, and semver forbids leading zeros ("2026.03.0" is rejected,
# "2026.3.0" is not). Every CalVer version also sorts above the old 0.x line.
#
# The counter continues from the highest of: this month's `vYYYY.M.*` tags in
# the repository, and package.json's own version if it is already in this
# month. With neither, the month starts at .0.
#
# Usage:
#   next-version.sh              Print the next version (no leading "v")
#
# Environment:
#   RELEASE_DATE=YYYY-MM         Use this month instead of the current UTC one
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ -n "${RELEASE_DATE:-}" ]]; then
  if ! [[ "$RELEASE_DATE" =~ ^([0-9]{4})-([0-9]{1,2})$ ]]; then
    echo "error: RELEASE_DATE must be YYYY-MM, got '$RELEASE_DATE'" >&2
    exit 1
  fi
  year="${BASH_REMATCH[1]}"
  month="$((10#${BASH_REMATCH[2]}))"
  if ((month < 1 || month > 12)); then
    echo "error: RELEASE_DATE month out of range: '$RELEASE_DATE'" >&2
    exit 1
  fi
else
  year="$(date -u +%Y)"
  month="$((10#$(date -u +%m)))"
fi

prefix="$year.$month"
highest=-1

consider() {
  local version="${1#v}"
  if [[ "$version" =~ ^${year}\.${month}\.([0-9]+)$ ]]; then
    local micro="$((10#${BASH_REMATCH[1]}))"
    ((micro > highest)) && highest="$micro"
  fi
  return 0
}

while IFS= read -r tag; do
  consider "$tag"
done < <(git -C "$REPO_ROOT" tag --list "v$prefix.*")

if [[ -f "$REPO_ROOT/package.json" ]]; then
  current="$(sed -nE 's/^[[:space:]]*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/p' \
    "$REPO_ROOT/package.json" | head -1)"
  [[ -n "$current" ]] && consider "$current"
fi

echo "$prefix.$((highest + 1))"
