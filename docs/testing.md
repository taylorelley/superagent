# Testing Superagent

Superagent has two distinct kinds of tests, each in its own directory:

- **`tests/`** — does the plugin's non-LLM code work? Bash + node integration tests for the OpenCode plugin, the brainstorm-server JS, and the repo's own scripts.
- **`evals/`** — do agents behave correctly on real LLM sessions? An external Bun/TypeScript harness driving real agent sessions, with a QA agent and deterministic post-checks judging skill compliance.

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

Live in `evals/`, cloned from [superpowers-evals](https://github.com/prime-radiant-inc/superpowers-evals/) — it is a separate repository and is not part of the published plugin. `quorum` is the harness; each scenario is a directory under `evals/scenarios/`. See `evals/README.md` for setup, credentials, and the safety model. Quick start:

```bash
cd evals
bun install
export SUPERPOWERS_ROOT=/path/to/superagent
export ANTHROPIC_API_KEY=sk-...
bun run quorum run scenarios/triggering-test-driven-development --coding-agent opencode
bun run quorum show <run-dir>
```

Pin the eval checkout to a commit or tag if you need a reproducible setup — its
CLI has changed shape before.

Live scenarios are slow (3-30+ minutes each), run real LLM sessions, and launch the agent under test in a permissive mode — run them only from a trusted local environment. They are not part of CI today; the natural follow-up is a tiered model (fast subset on PR, full sweep nightly + on-demand).
