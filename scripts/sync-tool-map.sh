#!/usr/bin/env bash
# Regenerate the OpenCode tool-mapping region in .opencode/INSTALL.md.
#
# The mapping lives in .opencode/lib/tool-map.js. The install guide carries a
# generated region between markers, and
# tests/opencode/test-tool-map-single-source.sh fails when it does not match
# the source.
#
# Run this after editing tool-map.js.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node "$REPO_ROOT/scripts/sync-tool-map.mjs" "$@"
