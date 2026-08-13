#!/usr/bin/env bash
# Regenerate the OpenCode tool-mapping regions in the documentation.
#
# The mapping lives in .opencode/lib/tool-map.js. It used to be restated in
# the plugin, INSTALL.md, and docs/README.opencode.md, which meant three
# chances to drift out of sync. The docs now carry generated regions between
# markers, and tests/opencode/test-tool-map-single-source.sh fails when they
# do not match the source.
#
# Run this after editing tool-map.js.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

node "$REPO_ROOT/scripts/sync-tool-map.mjs" "$@"
