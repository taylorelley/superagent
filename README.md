# Superagent

Superagent is a complete software development methodology for [OpenCode](https://opencode.ai), built on top of a set of composable skills and some initial instructions that make sure your agent uses them.

## Table of Contents

- [How it works](#how-it-works)
- [Installation](#installation)
- [The Basic Workflow](#the-basic-workflow)
- [Community](#community)
- [How Superagent Differs from Superpowers](#how-superagent-differs-from-superpowers)
- [What's Inside](#whats-inside)
- [Philosophy](#philosophy)
- [Contributing](#contributing)
- [Updating](#updating)
- [License](#license)

## How it works

It starts from the moment you fire up OpenCode. As soon as it sees that you're building something, it *doesn't* just jump into trying to write code. Instead, it steps back and asks you what you're really trying to do. 

Once it's teased a spec out of the conversation, it shows it to you in chunks short enough to actually read and digest. 

After you've signed off on the design, your agent puts together an implementation plan that's clear enough for an enthusiastic junior engineer with poor taste, no judgement, no project context, and an aversion to testing to follow. It emphasizes true red/green TDD, YAGNI (You Aren't Gonna Need It), and DRY. 

Next up, once you say "go", it launches a *subagent-driven-development* process, having agents work through each engineering task, inspecting and reviewing their work, and continuing forward. It's not uncommon for your agent to work autonomously for a couple hours at a time without deviating from the plan you put together.

There's a bunch more to it, but that's the core of the system. And because the skills trigger automatically, you don't need to do anything special. OpenCode just has Superagent.

## Installation

Superagent is a plugin for [OpenCode](https://opencode.ai).

- Tell OpenCode:

  ```text
  Fetch and follow instructions from https://raw.githubusercontent.com/taylorelley/superagent/refs/heads/main/.opencode/INSTALL.md
  ```

- Or add it to the `plugin` array in your `opencode.json` (global or
  project-level) and restart OpenCode:

  ```json
  {
    "plugin": ["superagent@git+https://github.com/taylorelley/superagent.git"]
  }
  ```

- Verify by asking: "What can Superagent do?"
- For the TUI sidebar panel — version, preset, roster, and the live job board —
  add the same entry to `tui.json`, which is where OpenCode's TUI reads its own
  plugin list. See [.opencode/INSTALL.md](.opencode/INSTALL.md).
- Install and troubleshooting details: [.opencode/INSTALL.md](.opencode/INSTALL.md)
- Full guide: [docs/README.opencode.md](docs/README.opencode.md)
- Superagent also registers a roster of specialist agents on OpenCode — see
  [docs/superagent.md](docs/superagent.md).


## The Basic Workflow

1. **brainstorming** - Activates before writing code. Refines rough ideas through questions, explores alternatives, presents design in sections for validation. Saves design document.

2. **using-git-worktrees** - Activates after design approval. Creates isolated workspace on new branch, runs project setup, verifies clean test baseline.

3. **writing-plans** - Activates with approved design. Breaks work into bite-sized tasks (2-5 minutes each). Every task has exact file paths, complete code, verification steps.

4. **subagent-driven-development** or **executing-plans** - Activates with plan. Dispatches fresh subagent per task with two-stage review (spec compliance, then code quality), or executes in batches with human checkpoints.

5. **test-driven-development** - Activates during implementation. Enforces RED-GREEN-REFACTOR: write failing test, watch it fail, write minimal code, watch it pass, commit. Deletes code written before tests.

6. **requesting-code-review** - Activates between tasks. Reviews against plan, reports issues by severity. Critical issues block progress.

7. **finishing-a-development-branch** - Activates when tasks complete. Verifies tests, presents options (merge/PR/keep/discard), cleans up worktree. For sequential dependent work, "push and create a PR" defaults to submitting a **stack of small PRs** (one per layer) via **using-stacked-prs**, not one PR for everything — using GitHub's native Stacked PRs (`gh-stack`) when available, or plain git + your forge's CLI otherwise.

**The agent checks for relevant skills before any task.** Mandatory workflows, not suggestions.

## Community

Superagent began as [Superpowers](https://github.com/obra/superpowers), built by [Jesse Vincent](https://blog.fsck.com) and the rest of the folks at [Prime Radiant](https://primeradiant.com). This is an OpenCode-only fork, maintained separately from upstream.

- **Issues with this fork**: https://github.com/taylorelley/superagent/issues
- **Upstream Superpowers**: https://github.com/obra/superpowers — the multi-harness original this fork diverged from
- **Discord**: [Join the upstream community](https://discord.gg/35wsABTejz) for general Superpowers support, questions, and discussion
- **Release notes for this fork**: see [RELEASE-NOTES.md](RELEASE-NOTES.md)

## How Superagent Differs from Superpowers

Superagent isn't just a rename. It's a fork that made two deliberate bets:
narrow the platform target down to one, and use the room that frees up to
build something upstream doesn't have.

**OpenCode-only, on purpose.** Upstream Superpowers targets many coding
agents — Claude Code, Codex, Cursor, Devin, Gemini CLI, Hermes, Kimi, Pi.
Superagent dropped all of that. Less surface area means less compatibility
code bending the skills to fit the lowest common denominator across
harnesses, and it means claims about plugin behavior can be verified against
OpenCode's actual source instead of assumed. See
[docs/superagent.md](docs/superagent.md#verified-behaviour-of-the-opencode-plugin-api)
for an example of what that buys: config-merge order, permission semantics,
and background-dispatch behavior read directly out of `sst/opencode`'s
source and tested against a live install, not inferred from docs.

**A new agent-team layer upstream doesn't have.** Superagent registers ten
specialist agents — orchestrator, implementer, implementer-deep,
task-reviewer, re-reviewer, code-reviewer, spec-reviewer, plan-reviewer,
oracle, librarian — each independently routable to its own model. This
matters because OpenCode's `task` tool has no per-call model parameter, so
per-role routing is otherwise impossible. In practice, it means you can run
cheap, fast models for grunt work (research, routine implementation) and
reserve stronger models for judgment calls (architecture, deep review),
instead of paying premium-model rates for every step.

**The job board closes a real gap in parallel dispatch.** Upstream's
`subagent-driven-development` skill already dispatches subagents in
parallel, but nothing upstream prevents two of them from writing the same
file — one succeeds, the other silently loses its work. Superagent's job
board has each dispatch declare a file-ownership claim and flags overlapping
claims before they collide, turning that silent failure into a visible
warning.

**The council adds optional cross-model verification.** For decisions that
are expensive to get wrong, `/council <question>` asks several distinct
models the same question in parallel and reports where they agree or
disagree — surfacing blind spots that asking a single model would miss
without any indication it happened.

**Permissions enforce the rules instead of just asking for them.**
Specialist agents have the `task` tool (and, for reviewers and advisors, the
`edit` tool) denied at the permission layer. "Don't dispatch further
subagents" is structurally guaranteed rather than a prompt instruction a
model could drift from under pressure.

**Nothing is lost — it's opt-in.** Setting `{"preset": "solo"}` turns the
whole agent-team layer off and reproduces the original single-agent
Superpowers workflow exactly. The roster, job board, and council are
additions layered on top, not a replacement you're forced into.

**Rebrand and a privacy fix, in the same pass.** Superagent renamed the
project throughout — package name, plugin entry point, env vars, skill
paths — and, while doing so, removed the brainstorming skill's telemetry
beacon that used to fetch a version-tagged image from `primeradiant.com` on
every session. The fork no longer phones home by default.

Together, these changes trade breadth (many harnesses, shallow support) for
depth (one harness, verified behavior, and a coordination layer that makes
multi-agent work safer and cheaper to run). Full technical detail — config
schema, model-routing examples, troubleshooting — lives in
[docs/superagent.md](docs/superagent.md).

## What's Inside

### Skills Library

**Testing**
- **test-driven-development** - RED-GREEN-REFACTOR cycle (includes testing anti-patterns reference)

**Debugging**
- **systematic-debugging** - 4-phase root cause process (includes root-cause-tracing, defense-in-depth, condition-based-waiting techniques)
- **verification-before-completion** - Ensure it's actually fixed

**Collaboration** 
- **brainstorming** - Socratic design refinement
- **writing-plans** - Detailed implementation plans
- **executing-plans** - Batch execution with checkpoints
- **dispatching-parallel-agents** - Concurrent subagent workflows
- **requesting-code-review** - Pre-review checklist
- **receiving-code-review** - Responding to feedback
- **using-git-worktrees** - Parallel development branches
- **using-stacked-prs** - Chain of small, reviewable PRs for sequential dependent work
- **finishing-a-development-branch** - Merge/PR decision workflow
- **subagent-driven-development** - Fast iteration with two-stage review (spec compliance, then code quality)

**Meta**
- **writing-skills** - Create new skills following best practices (includes testing methodology)
- **using-superagent** - Introduction to the skills system

## Philosophy

- **Test-Driven Development** - Write tests first, always
- **Systematic over ad-hoc** - Process over guessing
- **Complexity reduction** - Simplicity as primary goal
- **Evidence over claims** - Verify before declaring success

Read [the original release announcement](https://blog.fsck.com/2025/10/09/superpowers/).

## Contributing

The general contribution process for Superagent is below. Keep in mind that we don't generally accept contributions of new skills.

1. Fork the repository
2. Create a branch for your work
3. Follow the `writing-skills` skill for creating and testing new and modified skills
4. Submit a PR, being sure to fill in the pull request template.

Skill-behavior tests use the `quorum` eval harness from [superpowers-evals](https://github.com/prime-radiant-inc/superpowers-evals/), cloned into `evals/` — see `evals/README.md` for setup. Plugin-infrastructure tests live at `tests/` and run via the relevant `run-*.sh` or `npm test`.

See `skills/writing-skills/SKILL.md` for the complete guide.

## Updating

OpenCode installs Superagent through a git-backed package spec, so restarting
OpenCode usually picks up new commits. Some OpenCode and Bun versions pin the
resolved git dependency — see
[.opencode/INSTALL.md](.opencode/INSTALL.md#updating) if updates don't appear.

## License

MIT License - see LICENSE file for details
