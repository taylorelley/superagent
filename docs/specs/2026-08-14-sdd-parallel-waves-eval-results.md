# SDD Parallel Waves — eval results

- **Date:** 2026-08-14
- **Method:** single-scenario pressure test, 5 fresh sonnet subagents
  (`subagent_type: general-purpose`), each given only the shipped
  `## Parallel Waves` section of `skills/subagent-driven-development/SKILL.md`
  verbatim plus a seeded fixture plan — no repo access, no tools, pure
  reasoning from the provided text. Every reply read in full and scored by
  hand.
- **Design:** `2026-08-14-sdd-parallel-waves-design.md`
- **Why retroactive:** this eval was run 2026-08-14, after the feature it
  tests (PR #8, commits `8318429` et al.) had already merged. It exists to
  close the eval-evidence gap `AGENTS.md` requires and PR #8's own commit
  message admitted deferring ("a pressure-scenario eval of wave execution
  is follow-up, not part of this commit"). It validates the shipped text as
  it stands; it did not gate the merge.

## Scope

This is one scenario, run once, at smoke strength (5 reps) — not the
multi-round RED→GREEN campaign this project ran for comparable prior SDD
changes (e.g. `2026-07-06-sdd-plan-scoped-workspace-eval-results.md`'s 25
RED reps across three framings plus 15 GREEN reps across two arms). It
targets the single highest-risk failure mode in the Parallel Waves design:
a controller computing wave membership and the three gating conditions
correctly, but never actually applying the disjoint-`Files:` check before
dispatch — which the skill's own "Why not one shared tree" section names as
the concrete harm ("two tasks touching the same file both succeed — with
one silently losing work"). Regression behavior on a defect-free wave, the
merge-back/cleanup mechanics, and the fix-loop escalation policy are not
covered by this round and remain open follow-up (see Limitations).

## Scenario

A fixture plan (`docs/plans/2026-08-14-config-migration.md` in the prompt,
not a real file) with a Task Order & Dependencies table:

| Task | Depends on | Files |
|---|---|---|
| 1 | — | `src/schema.py` |
| 2 | 1 | `src/shared_config.py`, `src/reader.py` |
| 3 | 1 | `src/shared_config.py`, `src/writer.py` |
| 4 | 2, 3 | `src/cli.py` |

Task 1 is already merged. `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`
is stated as set. Wave 2 = {Task 2, Task 3} by the skill's own wave
computation rule — but Tasks 2 and 3 both claim `src/shared_config.py`, a
seeded plan defect: the disjoint-files check must catch it before any
dispatch, parallel or not. The subagent was told this is a pure reasoning
exercise (no tools, no file reads) and asked for a four-part structured
report: wave membership, the three parallelize gates individually, the
disjoint-files check, and its resolution. Full prompt is Appendix A.

## Scoring criteria

PASS iff all of:
1. Wave membership = {Task 2, Task 3} (Task 1 excluded as already done,
   Task 4 excluded as not yet dependency-satisfied).
2. All three gating conditions (table present, wave size ≥ 2, env var set)
   individually confirmed true.
3. The `src/shared_config.py` overlap between Task 2 and Task 3 is
   identified.
4. The rep does **not** dispatch Tasks 2 and 3 unchanged as a parallel wave.
   It takes one of the two sanctioned actions the skill text names —
   serialize the pair, or merge them into one task — and states a concrete
   next dispatch.

FAIL on any wrong wave membership, any gate misjudged, a missed or
misidentified overlap, or a resolution that dispatches the pair as-is
(silently reproducing the exact failure the design exists to prevent).

## Results

| Rep | Wave membership | Gates confirmed | Overlap caught | Resolution | PASS |
|---|---|---|---|---|---|
| 1 | {2,3} ✓ | ✓ | ✓ (`src/shared_config.py`) | Merge 2+3 into one task, dispatch serially | ✓ |
| 2 | {2,3} ✓ | ✓ | ✓ | Serialize: dispatch 2, merge, then dispatch 3 from post-merge HEAD | ✓ |
| 3 | {2,3} ✓ | ✓ | ✓ | Merge 2+3 into one task, dispatch serially | ✓ |
| 4 | {2,3} ✓ | ✓ | ✓ | Serialize: dispatch 2, merge, then dispatch 3 from post-merge HEAD | ✓ |
| 5 | {2,3} ✓ | ✓ | ✓ | Merge 2+3 into one task, dispatch serially | ✓ |

**5/5 PASS.** Every rep correctly excluded Task 1 (done) and Task 4
(dependency-unsatisfied) from the wave, correctly confirmed all three
parallelize gates as individually true, correctly identified
`src/shared_config.py` as the overlapping file between Tasks 2 and 3, and
never proposed dispatching the pair unchanged. The 5-rep split (3 merge, 2
serialize) is itself informative: both are explicitly sanctioned by the
skill text ("serialize the pair, or merge them into one task"), and no rep
treated the choice as forced — each gave a one-line rationale for picking
one over the other (rep 1: "splitting it in a serial order would just make
one of them redundant busywork"; rep 2: "to preserve the plan's task
boundaries and review ranges").

No rep needed correction or a second attempt; no wording changes to
`SKILL.md` were made as a result of this round.

## Limitations

Five reps on one scenario is a smoke-strength signal on the single riskiest
sub-behavior, not a validation of the whole Parallel Waves mechanism — it
says nothing about whether a controller correctly executes the
worktree/dispatch/merge-back mechanics end to end, correctly handles the
fix-loop escalation inside a wave, or behaves correctly on a wave with no
defect (this scenario only tests the defect-catching path, since that is
where a silent failure is costliest). It was also a pure text-reasoning
exercise — no rep actually ran `git worktree add`, dispatched a real
subagent, or touched a real repository, so it cannot catch a bug in the
mechanism itself (as opposed to a controller's understanding of it). A
follow-up round covering the defect-free happy path end-to-end, ideally as
a proper `superpowers-evals`/`quorum` scenario per `evals/README.md`, is
the natural next step and is not part of this round.

## Appendix A: scenario prompt

One fresh subagent per rep (`subagent_type: general-purpose`, model
`sonnet`), given this prompt verbatim.

```
You are acting as the controller in Anthropic's "subagent-driven-development"
skill, mid-execution of a real plan. This is a pure reasoning exercise: do
NOT read any files, do NOT run any bash or git commands, do NOT use any
tools. Everything you need is below. Reply with only the report format
specified at the end.

<skill-text source="skills/subagent-driven-development/SKILL.md, section: Parallel Waves">
## Parallel Waves

Plans declare task independence in their Task Order & Dependencies table. When
a wave of independent tasks exists, execute its members concurrently —
per-task worktrees, background dispatch, controller merge-back.

### When to parallelize

All three required, else serial:

1. The plan has a Task Order & Dependencies table.
2. A wave (the maximal set of tasks with no dependencies on each other) has
   size ≥ 2.
3. `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` is set.

If worktree creation fails (sandbox/permission), fall back to serial execution
in place, with a ledger note.

Wave computation: wave 1 is the tasks with no dependencies; wave k+1 is the
tasks whose every dependency is in waves 1..k. Before dispatching a wave,
verify every pair of tasks in it has disjoint `Files:` blocks. An overlap is a
plan defect: rule on it (serialize the pair, or merge them into one task),
ledger the ruling, then proceed.

### Per-task worktrees

One worktree per wave task:

  git worktree add .worktrees/<plan-basename>/t<N> -b <plan-basename>/t<N> <base>

`base` is the feature-branch HEAD after all dependency waves are merged — a
downstream task's tree must contain the interfaces it consumes. Run project
setup in each worktree (per using-git-worktrees Step 2). The main checkout is
never touched by a wave implementer.

### Dispatch

`background: true`, `workdir` = the task's worktree, the same dispatch
contract as the serial loop (brief path, report path, ownership boundary,
"commit on branch `<plan-basename>/t<N>`"). Dispatch every wave member in one
message. The job board's ownership conflict check stays live as a second net.

### Merge-back

After a task's review is clean: `git merge --no-ff <plan-basename>/t<N>` into
the feature branch. Disjoint files guarantee a clean merge. A merge conflict
means the plan's disjoint-files claim was wrong: stop, rule, ledger, resolve
or serialize, then continue. Merge order within a wave is unconstrained.

### Why not one shared tree

Parallel implementers on one branch interleave commits, which breaks
per-task review ranges, and two tasks touching the same file both succeed —
with one silently losing work. Per-task branches make ownership violations
loud merge conflicts and keep every review range exact.
</skill-text>

<environment>
OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true is set in this session.
Task 1 has already been dispatched, reviewed clean, and merged to the
feature branch. You are about to decide what to dispatch next.
</environment>

<plan file="docs/plans/2026-08-14-config-migration.md">
# Config Migration Implementation Plan

## Task Order & Dependencies

| Task | Depends on | Files |
|---|---|---|
| 1 | — | `src/schema.py` |
| 2 | 1 | `src/shared_config.py`, `src/reader.py` |
| 3 | 1 | `src/shared_config.py`, `src/writer.py` |
| 4 | 2, 3 | `src/cli.py` |

## Task 1: Storage schema

Define the on-disk config schema in `src/schema.py`.

**Files:** `src/schema.py`

## Task 2: Config reader

Add a reader in `src/reader.py` that loads config using the shared helpers in
`src/shared_config.py` (create this file with the path-resolution and
validation helpers both reader and writer need).

**Files:** `src/shared_config.py`, `src/reader.py`

## Task 3: Config writer

Add a writer in `src/writer.py` that saves config using the shared helpers in
`src/shared_config.py` (create this file with the atomic-write and
backup-rotation helpers both reader and writer need).

**Files:** `src/shared_config.py`, `src/writer.py`

## Task 4: CLI wiring

Wire `--config-get`/`--config-set` flags in `src/cli.py` to the reader and
writer.

**Files:** `src/cli.py`
</plan>

Using only the skill text and the plan above, decide what you dispatch next
and reply with EXACTLY this report format, nothing else:

1. WAVE MEMBERSHIP: which task numbers make up the wave you are about to
   dispatch, and why (cite the dependency data).
2. PARALLELIZE OR NOT: for this wave, state whether you dispatch it
   concurrently or serially, and confirm each of the three gating
   conditions individually (table present? wave size ≥ 2? env var set?).
3. DISJOINT-FILES CHECK: for every pair of tasks in the wave, state whether
   their Files: entries are disjoint or overlap. If any pair overlaps, say
   which files and which two tasks.
4. RESOLUTION: what you actually do given your answer to (3) — dispatch the
   wave as planned, or take one of the two sanctioned actions the skill
   text names for an overlap. Be concrete: if you serialize or merge
   tasks, say exactly what changes about what you dispatch next.

Be concrete and terse. That report is your entire deliverable.
```

## Appendix B: verbatim replies

**Rep 1** (PASS):

> 1. WAVE MEMBERSHIP: Tasks 2 and 3. Both depend only on Task 1 (`—` for
> 2→1, 3→1), and Task 1 is already merged, so all dependencies for 2 and 3
> are satisfied in waves 1..1. Task 4 depends on 2,3 (not yet done) so it
> is not in this wave.
>
> 2. PARALLELIZE OR NOT: Gating conditions — table present: yes (Task
> Order & Dependencies table exists). Wave size ≥ 2: yes (tasks 2 and 3).
> Env var set: yes (`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true` per
> environment note). All three conditions individually true, so this wave
> is a parallelize candidate — but must still pass the disjoint-files
> check before dispatching concurrently.
>
> 3. DISJOINT-FILES CHECK: Task 2 Files: `src/shared_config.py`,
> `src/reader.py`. Task 3 Files: `src/shared_config.py`, `src/writer.py`.
> These overlap on `src/shared_config.py` — both tasks are specified to
> create/own that file. Not disjoint.
>
> 4. RESOLUTION: This is a plan defect per the skill's own rule. I do not
> dispatch 2 and 3 as concurrent worktree tasks. I rule: merge the
> shared-file work into one task rather than serialize two full tasks,
> since both descriptions independently declare "create this file" for
> the same `src/shared_config.py` — splitting it in a serial order would
> just make one of them redundant busywork. Ledger note: "Tasks 2/3
> overlap on src/shared_config.py; ruling: merged into a single Task 2+3
> ('Config reader+writer + shared helpers') covering
> src/shared_config.py, src/reader.py, src/writer.py, dispatched serially
> (solo) since the merged task is now a size-1 wave." I then dispatch this
> merged task alone (not in parallel, since the resulting wave is size 1),
> and after it's reviewed clean and merged, proceed to Task 4 as the next
> (solo) wave.

**Rep 2** (PASS):

> 1. WAVE MEMBERSHIP: Tasks 2 and 3. Task 1 (dependency for both) is done.
> Task 2 depends on "1", Task 3 depends on "1" — per the table, both have
> their sole dependency satisfied, so both qualify for the next wave. Task
> 4 depends on "2, 3", not yet satisfied, so it is excluded.
>
> 2. PARALLELIZE OR NOT: Not parallelized — dispatched serially despite
> two conditions holding, because the third check (disjoint files) fails.
> Table present? Yes. Wave size ≥ 2? Yes, wave = {2, 3}, size 2. Env var
> set? Yes, OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true.
>
> 3. DISJOINT-FILES CHECK: Task 2 files: `src/shared_config.py`,
> `src/reader.py`. Task 3 files: `src/shared_config.py`, `src/writer.py`.
> Overlap: `src/shared_config.py` is claimed by both Task 2 and Task 3 —
> not disjoint.
>
> 4. RESOLUTION: This is a plan defect (both tasks write the same shared
> file with different helper sets). Ruling: serialize the pair rather than
> merge them into one task, to preserve the plan's task boundaries and
> review ranges. Ledger note: "Task 2/3 overlap on src/shared_config.py —
> serializing: dispatch Task 2 first (creates shared_config.py with
> path-resolution/validation helpers + reader.py), review and merge to
> feature branch, then dispatch Task 3 in a fresh worktree based on the
> updated feature branch HEAD (adds atomic-write/backup-rotation helpers
> to the existing shared_config.py + writer.py)." Concretely: next
> dispatch is Task 2 alone (worktree `.worktrees/config-migration/t2`),
> not a wave; Task 3 is deferred until Task 2 merges, then dispatched
> alone from the post-merge HEAD; Task 4 still waits on both.

**Rep 3** (PASS):

> 1. WAVE MEMBERSHIP: Tasks 2 and 3. Task 1 is merged, so per the
> dependency table both Task 2 (depends on 1) and Task 3 (depends on 1)
> have all dependencies satisfied and are the maximal set of tasks with no
> dependencies on each other — this is wave 2.
>
> 2. PARALLELIZE OR NOT: Table present — yes. Wave size ≥ 2 — yes (2
> tasks). Env var set — yes. All three gates pass, so the wave qualifies
> for concurrent dispatch — pending the disjoint-files check below.
>
> 3. DISJOINT-FILES CHECK: Task 2 files: `src/shared_config.py`,
> `src/reader.py`. Task 3 files: `src/shared_config.py`, `src/writer.py`.
> Overlap: `src/shared_config.py` is claimed by both — not disjoint.
>
> 4. RESOLUTION: This is a plan defect per the skill text. I do not
> dispatch tasks 2 and 3 as separate concurrent worktrees. Ruling: merge
> tasks 2 and 3 into a single combined task (new "Task 2+3") that creates
> `src/shared_config.py` (path-resolution + validation helpers from Task
> 2, atomic-write + backup-rotation helpers from Task 3) and implements
> both `src/reader.py` and `src/writer.py` in one branch/worktree. Ledger
> note: "Tasks 2 and 3 both write src/shared_config.py — disjoint-files
> check failed; ruled to merge into one task (t2+3) rather than
> serialize, since the two halves of shared_config.py are independent
> helper sets authored together to avoid a two-step edit of the same
> file." I dispatch this single merged task alone (wave size 1, serial
> execution) in a worktree `.worktrees/config-migration/t2+3` on branch
> `config-migration/t2+3`, based on the feature branch HEAD after Task 1's
> merge. Task 4 remains blocked until this merged task is reviewed clean
> and merged back.

**Rep 4** (PASS):

> 1. WAVE MEMBERSHIP: Tasks 2 and 3. Task 1 is the only task with no
> dependency and it's already merged. Tasks 2 and 3 both list "Depends on:
> 1" and 1 is satisfied, so they're the maximal set whose every dependency
> is in wave 1 — they form wave 2. Task 4 depends on 2 and 3, not yet
> satisfied, so it isn't eligible.
>
> 2. PARALLELIZE OR NOT: (a) Task Order & Dependencies table present: yes.
> (b) wave size ≥ 2: yes, {2,3}. (c) env var set: yes. All three
> conditions individually hold, so parallel dispatch is indicated —
> pending the disjoint-files check below, which overrides.
>
> 3. DISJOINT-FILES CHECK: Task 2 files: `src/shared_config.py`,
> `src/reader.py`. Task 3 files: `src/shared_config.py`, `src/writer.py`.
> Overlap: `src/shared_config.py` is claimed by both — not disjoint.
>
> 4. RESOLUTION: This is a plan defect per the skill text; I rule on it
> rather than dispatching wave 2 as-is. Ruling: serialize the pair on the
> shared file. I dispatch Task 2 alone first (worktree
> `.worktrees/2026-08-14-config-migration/t2` off the post-Task-1 feature
> branch HEAD), since it's the one that must originate
> `shared_config.py`'s path-resolution/validation helpers. After Task 2 is
> reviewed clean and merged to the feature branch, I dispatch Task 3 next,
> with its worktree branched from the updated feature-branch HEAD (now
> containing Task 2's `shared_config.py`), so Task 3 adds its
> atomic-write/backup-rotation helpers onto the already-merged file
> instead of racing Task 2 for it. Task 3 is thus treated as depending on
> Task 2 in addition to Task 1 for dispatch-ordering purposes (ledger
> note: "Task 2/3 file overlap on src/shared_config.py — serialized 2
> then 3, not run as a parallel wave"). Task 4 remains queued behind both.

**Rep 5** (PASS):

> 1. WAVE MEMBERSHIP: Tasks 2 and 3. Both depend only on Task 1, which is
> already merged, so both dependencies are satisfied. Neither depends on
> the other, so they form the next wave (wave 2). Task 4 depends on 2 and
> 3, so it is not in this wave.
>
> 2. PARALLELIZE OR NOT: Table present: yes. Wave size ≥ 2: yes, wave =
> {2, 3}, size 2. Env var set: yes. All three pass, but per the skill the
> disjoint-files check must be verified before dispatch — see below,
> which overrides straightforward parallel dispatch.
>
> 3. DISJOINT-FILES CHECK: Task 2 files: `src/shared_config.py`,
> `src/reader.py`. Task 3 files: `src/shared_config.py`, `src/writer.py`.
> Overlap: `src/shared_config.py` is claimed by both tasks. Not disjoint.
>
> 4. RESOLUTION: This is a plan defect (both tasks author the same shared
> file with different, coexisting helpers). I do not dispatch 2 and 3
> concurrently. Ruling: merge the two tasks into a single combined task
> ("Task 2+3: Config reader/writer + shared helpers") covering
> `src/shared_config.py`, `src/reader.py`, `src/writer.py`, dispatched as
> one serial subagent from the Task-1 merge point. Ledger note: "Wave 2
> defect — Task 2 and Task 3 both write src/shared_config.py; merged into
> single task 2+3, dispatched serially, not as a parallel wave." Task 4
> then proceeds as before, depending on the completion of combined task
> 2+3.
