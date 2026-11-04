# Superagent — Contributor Guidelines

## What This Repo Is

Superagent is a fork of [Superpowers](https://github.com/obra/superpowers) for
two hosts: [OpenCode](https://opencode.ai) 2 and
[Claude Code](https://code.claude.com). Both carry the whole agent team —
subagents with enforced roles, per-role model routing, and dispatch hooks the
job board can see — and both plugins must keep **feature parity**: a feature
added to one is added to the other, or the gap is documented in
`docs/claude-code.md` with the reason the host cannot carry it. Support for
other harnesses — Codex, Cursor, Gemini CLI, Kimi, Hermes, Pi, and the rest —
was removed on purpose. Do not add it back, and do not open PRs against
`obra/superpowers` from this tree: the two projects have diverged.

## Layout

- `skills/` — the skills, one directory each with a `SKILL.md`, shared by both hosts
- `core/` — everything both hosts share: roster, config, presets, permissions, board, ownership, routing, council, bootstrap, tool maps, prompt extraction, panel layout
- `.opencode/plugins/superagent.js` — the OpenCode server plugin entry point
- `.opencode/lib/` — OpenCode modules (registration, skills, commands, update installer, TUI data); shims re-export what moved to `core/`
- `.opencode/prompts/` — agent prompts (both hosts read them)
- `.opencode/tui/` — the OpenCode TUI sidebar panel entry point
- `.claude-plugin/` — the Claude Code plugin manifest and marketplace
- `claude-code/` — the Claude Code hooks module (`superagent.js`) and its pure translations (`lib/`)
- `docs/superagent.md` — the agent-team layer: roster, per-slot model routing, job board, council
- `docs/claude-code.md` — how the team lands in Claude Code, and where the hosts differ
- `tests/` — plugin and script tests; see `docs/testing.md`

## Scope

- **OpenCode and Claude Code only.** No manifests, hooks, bootstrap shims,
  docs, or skill content for another harness.
- **Shared logic lives in `core/`.** It must run in both hosts: no Node
  modules and no host globals (a Claude Code hooks module has no `process` or
  `fetch`; ESLint enforces this). Host I/O stays in each host's adapter, and a
  Claude Code hooks module may call the mods API only from its own file.
- **Skills stay host-neutral.** They name actions, not tools; each host's
  tool map (`core/tool-map.js`) translates.
- **Zero dependencies.** The plugin ships no runtime dependencies. A skill may
  shell out to a tool the user may already have (a forge CLI, `gh-stack`) only
  if it detects the tool at runtime and works fully without it, as
  `finishing-a-development-branch` and `using-stacked-prs` do.
- **General-purpose.** Skills and configuration for a specific project, team,
  domain, or third-party service belong in a separate plugin.

## Making Changes

- Use `superagent:writing-skills` when creating or editing a skill.
- Run the plugin tests before opening a PR: `bash tests/opencode/run-tests.sh`
  and `bash tests/claude-code/run-tests.sh`, plus the suite for whatever else
  you touched (see `docs/testing.md`).
  CI also runs ESLint, Prettier, and shellcheck (`npm run lint`,
  `npm run format:check`, `bash scripts/lint-shell.sh --all`).
- Keep each PR to one change, and fill in the PR template.
- Don't bump the version by hand. Every merge to `main` is released
  automatically with a CalVer version; see `.github/RELEASING.md`.
