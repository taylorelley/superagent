# SDD Parallel Waves — Design Spec

**Status:** Retroactive design record, written 2026-08-14. The feature this
document describes already shipped — commits `8318429`, `85b30f6`,
`1d4fe76`, `909f269`, `e960889`, merged in PR #8 (2026-08-14) — without a
design record or eval evidence. `AGENTS.md`'s "Skill Changes Require
Evaluation" expects both for a skill-content change; a code review of PR #8
flagged the gap. This document backfills the design rationale from the
shipped text; it is not a pre-implementation plan, and it does not claim the
decisions below were reviewed before the code merged. Eval evidence
(likewise retroactive) is in the companion
`2026-08-14-sdd-parallel-waves-eval-results.md`.

**Objective:** let `subagent-driven-development` dispatch independent plan
tasks concurrently instead of always serially, without weakening the
review-isolation or ownership guarantees the serial loop provides.

**Hard invariant:** a wave's implementers never share a working tree or a
branch. Concurrency is bought with per-task worktrees and branches, not by
relaxing the one-diff-per-review contract.

## Problem

Before this change, `subagent-driven-development` dispatched every task in
a plan one at a time, even when the plan's own Task Order & Dependencies
table showed two or more tasks with no dependency on each other. A plan
with, say, five independent tasks paid the full serial sum of their
wall-clock time, purely because the skill had no mechanism to recognize or
act on that independence.

## Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| 1 | Compute waves from the plan's existing Task Order & Dependencies table (wave 1 = no dependencies; wave k+1 = every dependency in waves 1..k). No new plan syntax. | The table already encodes the dependency graph `writing-plans` requires; waves are a derived property, not new input the plan author has to author twice. |
| 2 | One git worktree and branch per wave task (`.worktrees/<plan-basename>/t<N>` on `<plan-basename>/t<N>`), not one shared tree for the wave. | A shared tree lets parallel implementers interleave commits, which breaks per-task review ranges, and lets two tasks touching the same file both "succeed" with one silently overwriting the other. Per-task branches turn an ownership violation into a loud merge conflict instead of a silent one. |
| 3 | Before dispatch, verify every pair of tasks in the wave has disjoint `Files:` blocks. An overlap is treated as a plan defect — serialize the pair or merge them into one task, ledger the ruling — never dispatched as-is. | Files: blocks are the plan's own ownership claim; an overlap means the plan's independence claim was wrong, and it is cheaper to catch that before two subagents write conflicting diffs than after. |
| 4 | Three conditions gate parallelism, all required: a Task Order & Dependencies table exists, the computed wave has size ≥ 2, and `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` is set. Any one missing → serial, unconditionally. | The env var keeps background dispatch opt-in while it's experimental; the size-≥-2 and table checks mean a plan with no real parallelism (or no dependency data at all) never pays worktree-setup overhead for a wave of one. |
| 5 | The review package for task N is `base..<plan-basename>/t<N>`, where `base` is the same feature-branch HEAD the worktree was created from. Merge order within a wave is unconstrained. | Because each task's branch only ever contains that task's commits, the range is exact without needing to track a moving merge-base per task. Unconstrained merge order is safe specifically because disjoint files were verified pre-dispatch (decision 3) — a merge conflict, if one occurs anyway, means that verification was wrong and is treated as a stop-the-line signal (see Mechanism). |
| 6 | Fix loops resume the same implementer in its own worktree/branch for rounds 1-3, then escalate to a fresh implementer on a more capable model in rounds 4-5 — mirroring the serial loop's existing escalation policy, unchanged in shape. | Consistency: parallel dispatch changes *where* work happens (per-task tree) and *when* it happens (concurrently), not the fix-loop policy `sdd-fix-loop-redesign` already established for the serial case. |
| 7 | `git worktree remove` + branch delete per task after its merge lands; `git worktree prune` once the whole wave is done. If worktree creation fails outright (sandbox/permission), fall back to serial execution in place, with a ledger note. | The failure mode this guards is a container or sandbox that permits worktree creation for the main checkout but not for `.worktrees/`; degrading to serial keeps the plan executable rather than blocking on an environment limitation. |

## Mechanism

**Wave computation.** Wave 1 = tasks with no dependencies; wave k+1 = tasks
whose every dependency is in waves 1..k (`writing-plans` §Task Order &
Dependencies carries the same rule so the controller and the plan author
compute identical waves from identical input).

**Per-task worktrees.** `git worktree add .worktrees/<plan-basename>/t<N>
-b <plan-basename>/t<N> <base>`, where `base` is the feature-branch HEAD
after all of the task's dependency waves are merged — so a downstream
task's tree already contains the interfaces it consumes. Project setup runs
in each worktree per `using-git-worktrees` Step 2. The main checkout is
never touched by a wave implementer.

**Dispatch.** Every wave member is dispatched in one message, each with
`background: true` and `workdir` set to its own worktree, using the same
five-part dispatch contract (brief path, report path, ownership boundary,
branch name) the serial loop already uses. The job board's ownership-
conflict check stays live underneath as a second net.

**Merge-back.** `git merge --no-ff <plan-basename>/t<N>` into the feature
branch once that task's review is clean. A merge conflict here means the
plan's disjoint-files claim (decision 3) was wrong despite the pre-dispatch
check — the controller stops, rules on it, resolves or serializes the
remainder, and ledgers the ruling.

**Review isolation.** Task N's own branch never contains another task's
commits, so `base..<plan-basename>/t<N>` is always the exact diff for that
task, independent of merge order or how many sibling tasks have already
landed.

**Cleanup.** After a task's branch merges and review is clean:
`git worktree remove` and `git branch -d` for that task; `git worktree
prune` once the wave completes.

**Efficiency.** A wave of *k* tasks costs approximately
`max(task times) + k × (worktree setup + merge + review)` in wall-clock,
instead of the sum of task times run serially. `subagent-driven-development`
notes explicitly that provider rate limits may throttle the realized
concurrency — an environment fact, not a reason to serialize the design.

## Alternatives Considered

**One shared worktree for the whole wave**, with implementers committing to
the same branch. Rejected: parallel commits to one branch interleave,
which breaks the exact-diff property review isolation depends on, and two
implementers touching the same file both "succeed" locally with one
silently discarding the other's work on merge/rebase. Per-task worktrees
make that failure mode a loud merge conflict instead.

**New plan syntax for declaring waves explicitly**, rather than deriving
them from the existing dependency table. Rejected: the dependency table is
already required by `writing-plans` and already fully determines the wave
structure; a second, parallel way to declare the same information would
only create a place for the two to drift out of sync.

## Non-Goals

- Changing the serial loop's fix-loop escalation policy (rounds 1-3 resume,
  4-5 escalate) — parallel waves reuse it unchanged per task.
- Cross-repository or cross-machine parallelism — waves are per-task
  worktrees within one working tree.
- Automatic conflict resolution when the disjoint-files check is wrong —
  that case is always a controller-adjudicated stop, never silent.

## Evaluation

See `2026-08-14-sdd-parallel-waves-eval-results.md`: a retroactive
pressure test of the two decisions most likely to fail silently if a
controller misreads this section — wave-gate computation and the
disjoint-files defect check — run against fresh subagents given only the
shipped SKILL.md text and a seeded plan defect.
