# Testing Superpowers

Superpowers has two distinct kinds of tests, each in its own directory:

- **`tests/`** — does the plugin's non-LLM code work? Bash + node integration tests for the OpenCode plugin, the brainstorm-server JS, and the repo's own scripts.
- **`evals/`** — do agents behave correctly on real LLM sessions? An external Python harness driving real agent sessions, with an LLM actor and verifier judging skill compliance.

## Plugin tests

Live in `tests/`. Currently:

- `tests/opencode/` — bash + node tests for OpenCode plugin loading, bootstrap caching, the Superagent roster, the job board, and the single-source tool map.
- `tests/brainstorm-server/` — node test suite for the brainstorm server JS code.
- `tests/systematic-debugging/` — bash tests for the `find-polluter` helper.
- `tests/writing-skills/` — bash tests for the graph renderer.
- `tests/shell-lint/` — bash tests for `scripts/lint-shell.sh`.
- `tests/version-bump/` — bash tests for `scripts/bump-version.sh`.

Run plugin tests via the relevant directory's `run-*.sh`, the individual
`test-*.sh`, or `npm test` where the directory has a `package.json`.

## Skill behavior evals

Live in `evals/`, cloned from [superpowers-evals](https://github.com/prime-radiant-inc/superpowers-evals/) — it is a separate repository and is not part of the published plugin. Drill is the harness; scenarios live at `evals/scenarios/*.yaml`. See `evals/README.md` for setup and for the backends it can drive. Quick start:

```bash
cd evals
uv sync --extra dev
uv run drill run triggering-test-driven-development
```

Drill scenarios are slow (3-30+ minutes each) and run real LLM sessions. They are not part of CI today; the natural follow-up is a tiered model (fast subset on PR, full sweep nightly + on-demand).
