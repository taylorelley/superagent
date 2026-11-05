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

## Codex adapter

`bash tests/codex/run-tests.sh` runs the adapter contracts and hook subprocess
regressions. `--integration` (or `REQUIRE_CODEX=1`) additionally requires the
Codex binary and runs `tests/codex/native.mjs`; it fails if the binary is missing.
CI installs `@openai/codex@0.166.0-alpha.1` and requires native acceptance.

The native fixture installs a temporary local marketplace and plugin, approves
only that temporary bundle's exact hook hashes, and scripts all model responses
through a loopback HTTP server. It does not touch the user's Codex home, use a
live provider, or require model credentials. It verifies shared and command
skill discovery, hook registration/execution, model and effort routing,
fresh-context dispatch, three concurrent children, council shell/delegation
withholding, an actual blocked shell side effect, project-isolated role-cache
registration, and the durable board's child links and terminal states.

A sandbox that forbids child processes or loopback sockets cannot run native
acceptance. Run it with those execution permissions; do not count a skipped or
mock-only run as native host validation. Skill guidance with real models and
non-Linux platforms remain unverified.

The accepted Codex completion criterion is plugin-scoped. Run
`node codex/probe.mjs --integration` to collect both contract and native-host
evidence. A passing run reports `pluginComplete: true`; the separate
`fullParity` field records strict cross-host differences and does not require
changes to Codex. Missing, stale or failed evidence still prevents completion.
