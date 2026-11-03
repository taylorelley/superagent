# Testing Superagent

Superagent's tests live in `tests/`: bash + node tests for the OpenCode plugin, the brainstorm-server JS, and the repo's own scripts.

## Plugin tests

Live in `tests/`. Currently:

- `tests/opencode/` — bash + node tests for OpenCode plugin loading, bootstrap caching, the Superagent roster, the job board, the TUI panel, and the single-source tool map. They drive the plugin's OpenCode 2 `setup(ctx)` against `tests/opencode/fake-v2-context.mjs`, a fake plugin context that replays transforms the way OpenCode does, so they need no binary.
- `tests/opencode/test-tools.sh` and `test-priority.sh` (`run-tests.sh --integration`) run a real OpenCode 2 and need a model. Any provider works, including a local OpenAI-compatible one injected with `OPENCODE_CONFIG_CONTENT`.
- `tests/brainstorm-server/` — node test suite for the brainstorm server JS code.
- `tests/systematic-debugging/` — bash tests for the `find-polluter` helper.
- `tests/writing-skills/` — bash tests for the graph renderer.
- `tests/shell-lint/` — bash tests for `scripts/lint-shell.sh`.
- `tests/version-bump/` — bash tests for `scripts/bump-version.sh`.

Run plugin tests via the relevant directory's `run-*.sh`, the individual
`test-*.sh`, or `npm test` where the directory has a `package.json`.
