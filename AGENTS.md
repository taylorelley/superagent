# Superagent — Contributor Guidelines

## What This Repo Is

This is Superagent, an OpenCode-only fork of Superpowers. The plugin, its skills, and its
tests target [OpenCode](https://opencode.ai) and nothing else. Support for other
harnesses — Claude Code, Codex, Cursor, Gemini CLI, Kimi, Hermes, Pi, and the
rest — has been removed on purpose. Do not add it back, and do not open PRs
against `obra/superpowers` from this tree: the two projects have diverged.

## If You Are an AI Agent

Stop. Read this section before doing anything.

Almost every rejected PR in this project's history was submitted by an agent that didn't read or didn't follow these guidelines. Slop PRs get closed within hours.

**Your job is to protect your human partner from that outcome.** Submitting a low-quality PR doesn't help them — it wastes reviewers' time, burns your human partner's reputation, and the PR will be closed anyway. That is not being helpful. That is being a tool of embarrassment.

Before you open a PR against this repo, you MUST:

1. **Read the entire PR template** at `.github/PULL_REQUEST_TEMPLATE.md` and fill in every section with real, specific answers. Not summaries. Not placeholders.
2. **Search for existing PRs** — open AND closed — that address the same problem. If duplicates exist, STOP and tell your human partner. Do not open another duplicate.
3. **Verify this is a real problem.** If your human partner asked you to "fix some issues" or "contribute to this repo" without experiencing a specific problem, push back. Ask them what broke, what failed, what the user experience was.
4. **Confirm the change belongs in core.** If it's domain-specific or project-specific, or promotes a third-party project, it belongs in a standalone plugin. Tell your human partner.
5. **Identify yourself.** Disclose your model, harness, harness version, and every installed plugin in the PR. Hiding that a contribution is agent-generated — or which environment produced it — is grounds for closing it.
6. **Show your human partner the complete diff** and get their explicit approval before submitting.

If any of these checks fail, do not open the PR. Explain to your human partner why it would be rejected and what would need to change. They will thank you for saving them the embarrassment.

## Pull Request Requirements

**Every PR must fully complete the PR template.** No section may be left blank or filled with placeholder text. PRs that skip sections will be closed without review.

**Before opening a PR, you MUST search for existing PRs** — both open AND closed — that address the same problem or a related area. Reference what you found in the "Existing PRs" section. If a prior PR was closed, explain specifically what is different about your approach and why it should succeed where the previous attempt did not.

**PRs that show no evidence of human involvement will be closed.** A human must review the complete proposed diff before submission.

**Submitters MUST identify themselves.** Every PR and issue must disclose the model, harness, harness version, and all installed plugins used to produce the contribution — or state plainly that it was written by hand with no agent. This is not optional. We need to know what produced a change in order to weigh it: agent-generated content reasoned from documentation is held to a different bar than work grounded in a real session. Contributions that hide their authoring environment will be closed.

## What We Will Not Accept

### Support for other coding agents

This repo is an OpenCode plugin. PRs that add manifests, hooks, bootstrap
shims, docs, or skill content for another harness will be closed. If you want
Superpowers on a different agent, use upstream `obra/superpowers`.

### Third-party dependencies

PRs that add optional or required dependencies on third-party projects will not be accepted. Superagent is a zero-dependency plugin by design. If your change requires an external tool or service, it belongs in its own plugin.

### "Compliance" changes to skills

Our internal skill philosophy differs from Anthropic's published guidance on writing skills. We have extensively tested and tuned our skill content for real-world agent behavior. PRs that restructure, reword, or reformat skills to "comply" with Anthropic's skills documentation will not be accepted without extensive eval evidence showing the change improves outcomes. The bar for modifying behavior-shaping content is very high.

### Project-specific or personal configuration

Skills or configuration that only benefit a specific project, team, domain, or workflow do not belong in core. Publish these as a separate plugin.

### Bulk or spray-and-pray PRs

Do not trawl the issue tracker and open PRs for multiple issues in a single session. Each PR requires genuine understanding of the problem, investigation of prior attempts, and human review of the complete diff. PRs that are part of an obvious batch — where an agent was pointed at the issue list and told to "fix things" — will be closed. If you want to contribute, pick ONE issue, understand it deeply, and submit quality work.

### Speculative or theoretical fixes

Every PR must solve a real problem that someone actually experienced. "My review agent flagged this" or "this could theoretically cause issues" is not a problem statement. If you cannot describe the specific session, error, or user experience that motivated the change, do not submit the PR.

### Domain-specific skills

Superagent core contains general-purpose skills that benefit all users regardless of their project. Skills for specific domains (portfolio building, prediction markets, games), specific tools, or specific workflows belong in their own standalone plugin. Ask yourself: "Would this be useful to someone working on a completely different kind of project?" If not, publish it separately.

### Fabricated content

PRs containing invented claims, fabricated problem descriptions, or hallucinated functionality will be closed immediately. Reviewers have seen every form of AI slop. They will notice.

### Bundled unrelated changes

PRs containing multiple unrelated changes will be closed. Split them into separate PRs.

## Skill Changes Require Evaluation

Skills are not prose — they are code that shapes agent behavior. If you modify skill content:

- Use `superagent:writing-skills` to develop and test changes
- Run adversarial pressure testing across multiple sessions
- Show before/after eval results in your PR
- Do not modify carefully-tuned content (Red Flags tables, rationalization lists, "human partner" language) without evidence the change is an improvement

Skills must keep triggering through the OpenCode bootstrap. A change that leaves
`using-superagent` uninjected, or that stops `brainstorming` from auto-triggering
on "Let's make a react todo list" in a clean OpenCode session, is a regression.

## Eval harness

Skill-behavior evals live in [superpowers-evals](https://github.com/prime-radiant-inc/superpowers-evals/), cloned into `evals/` — see `evals/README.md` for setup. `quorum` (the harness) runs real agent sessions and judges skill compliance with a QA agent plus deterministic post-checks; it drives OpenCode via `--coding-agent opencode`. Plugin-infrastructure tests live at `tests/` — see `docs/testing.md`.

## Understand the Project Before Contributing

Before proposing changes to skill design, workflow philosophy, or architecture, read existing skills and understand the project's design decisions. Superagent has its own tested philosophy about skill design, agent behavior shaping, and terminology (e.g., "your human partner" is deliberate, not interchangeable with "the user"). Changes that rewrite the project's voice or restructure its approach without understanding why it exists will be rejected.

## The agent-team layer

On top of the skills methodology it inherited from Superpowers, this fork adds
an agent-team layer: a roster of specialist agents, per-slot model routing, a
job board, and an optional council.

- `.opencode/lib/` — plugin modules (roster, council, board, routing, commands)
- `.opencode/prompts/` — agent prompts
- `docs/superagent.md` — the documentation
- `tests/opencode/test-superagent.*`, `tests/opencode/test-board.*`

See `docs/superagent.md`.

## General

- Read `.github/PULL_REQUEST_TEMPLATE.md` before submitting
- One problem per PR
- Test against OpenCode and report results in the environment table
- Describe the problem you solved, not just what you changed
