# Testing Superagent

Superagent's tests live in `tests/`: bash + node tests for the OpenCode plugin, Claude Code tests for its hooks module, the brainstorm-server JS, and the repo's own scripts.

## Plugin tests

Live in `tests/`. Currently:

- `tests/opencode/` — bash + node tests for OpenCode plugin loading, bootstrap caching, the Superagent roster, the job board, the TUI panel, and the single-source tool map. They drive the plugin's OpenCode 2 `setup(ctx)` against `tests/opencode/fake-v2-context.mjs`, a fake plugin context that replays transforms the way OpenCode does, so they need no binary.
- `tests/opencode/test-tools.sh` and `test-priority.sh` (`run-tests.sh --integration`) run a real OpenCode 2 and need a model. Any provider works, including a local OpenAI-compatible one injected with `OPENCODE_CONFIG_CONTENT`.
- `tests/claude-code/` — the Claude Code plugin. `run-tests.sh` runs the node unit tests (`test-claude-code.mjs`: the real prompt templates through the shared extraction, the manifests and their versions, the hooks module's import graph, and the model, permission and path translations), then `claude plugin validate` and `claude plugin test`. The latter runs `superagent.test.ts` in Claude Code's own engine, which loads the hooks module and raises real events at it, with no sign-in or network. Without the `claude` CLI those two steps are skipped; CI installs a pinned version and sets `REQUIRE_CLAUDE=1`.
- `tests/brainstorm-server/` — node test suite for the brainstorm server JS code.
- `tests/systematic-debugging/` — bash tests for the `find-polluter` helper.
- `tests/writing-skills/` — bash tests for the graph renderer.
- `tests/shell-lint/` — bash tests for `scripts/lint-shell.sh`.
- `tests/version-bump/` — bash tests for `scripts/bump-version.sh`.
- `tests/release/` — bash tests for `scripts/next-version.sh`, which picks the next release version.

Run plugin tests via the relevant directory's `run-*.sh`, the individual
`test-*.sh`, or `npm test` where the directory has a `package.json`.
