# Superagent — Contributor Guidelines

## What This Repo Is

Superagent is an OpenCode-only fork of
[Superpowers](https://github.com/obra/superpowers). The plugin, its skills, and
its tests target [OpenCode](https://opencode.ai) 2 and nothing else. Support for
other harnesses — Claude Code, Codex, Cursor, Gemini CLI, Kimi, Hermes, Pi, and
the rest — was removed on purpose. Do not add it back, and do not open PRs
against `obra/superpowers` from this tree: the two projects have diverged.

## Layout

- `skills/` — the skills, one directory each with a `SKILL.md`
- `.opencode/plugins/superagent.js` — the server plugin entry point
- `.opencode/lib/` — plugin modules (bootstrap, skills, roster, council, board, routing, commands, TUI panel)
- `.opencode/prompts/` — agent prompts
- `.opencode/tui/` — the TUI sidebar panel entry point
- `docs/superagent.md` — the agent-team layer: roster, per-slot model routing, job board, council
- `tests/` — plugin and script tests; see `docs/testing.md`

## Scope

- **OpenCode only.** No manifests, hooks, bootstrap shims, docs, or skill
  content for another harness.
- **Zero dependencies.** The plugin ships no runtime dependencies. A skill may
  shell out to a tool the user may already have (a forge CLI, `gh-stack`) only
  if it detects the tool at runtime and works fully without it, as
  `finishing-a-development-branch` and `using-stacked-prs` do.
- **General-purpose.** Skills and configuration for a specific project, team,
  domain, or third-party service belong in a separate plugin.

## Making Changes

- Use `superagent:writing-skills` when creating or editing a skill.
- Run the plugin tests before opening a PR: `bash tests/opencode/run-tests.sh`,
  plus the suite for whatever else you touched (see `docs/testing.md`).
  CI also runs ESLint, Prettier, and shellcheck (`npm run lint`,
  `npm run format:check`, `bash scripts/lint-shell.sh --all`).
- Keep each PR to one change, and fill in the PR template.
