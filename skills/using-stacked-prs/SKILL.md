---
name: using-stacked-prs
description: Use when a worktree or plan produces more than one logically sequential layer of work (dependent tasks, dependent waves) that needs review as a chain of small PRs instead of one large one - selects gh-stack when available, otherwise manages the chain with plain git and forge CLI commands
---

# Using Stacked PRs

## Overview

A **stack** is an ordered chain of branches rooted on a trunk, where each
branch has exactly one PR based on the branch below it:
`(main) <- layer-1 <- layer-2 <- layer-3`. Left is the bottom (merges
first), right is the top (merges last). Reviewers see one layer's diff at a
time instead of the whole chain at once.

**Core principle:** Stacking is the default for sequential/dependent work.
The mechanism — GitHub's native `gh-stack` extension, or plain git — is a
runtime choice, never a reason to fall back to one big PR.

**Announce at start:** "I'm using the using-stacked-prs skill to manage this as a chain of PRs."

## Step 0: Capability Probe

Run once per session/branch, not on every subsequent step:

```bash
command -v gh >/dev/null 2>&1 && HAVE_GH=1
gh extension list 2>/dev/null | grep -q gh-stack && HAVE_GH_STACK=1
git remote get-url origin 2>/dev/null | grep -q 'github\.com' && ON_GITHUB=1
```

If `HAVE_GH` and `ON_GITHUB` but not `HAVE_GH_STACK`: offer to install it
— "This repo is on GitHub. Install the `gh-stack` extension for native
Stacked PRs? (`gh extension install github/gh-stack`)" This is the only
place this skill installs third-party tooling, and only with consent.

If all three are set, confirm the feature is actually enabled on this repo:

```bash
gh stack view --json >/dev/null 2>&1; echo $?
```

Exit 0 (or 2, "not in a stack yet" — still means the feature works) →
**tooled mode**. Exit 9 ("stacked PRs not enabled on repo") or any other
failure, or a missing prerequisite above → **manual mode**. Report the mode
once: "Using gh-stack (native)" or "Using manual stacking (plain git)".

## Tooled Mode (gh-stack)

Wraps `github/gh-stack` directly. **Always pass non-interactive flags** —
bare `gh stack init`/`modify` open a TUI that hangs under agent execution.

| Verb | Command |
|------|---------|
| Start a stack | `gh stack init <first-branch>` |
| Add a layer | `gh stack add <branch>` (branches from current top) |
| Push + open PRs | `gh stack submit --auto` (draft) or `--open` (ready for review) |
| Reconcile with remote | `gh stack sync --prune` |
| Cascade a rebase | `gh stack rebase` (`--continue`/`--abort` if interrupted) |
| Land one layer + everything below | `gh stack merge <target> --yes` |
| Inspect state | `gh stack view --json` |

### Exit codes

| Code | Meaning | Action |
|------|---------|--------|
| 0 | Success | Continue |
| 2 | Not in a stack | `gh stack init` first |
| 3 | Rebase conflict | Stop. Resolve, then `gh stack rebase --continue`. Never force through — hand back to your human partner if the conflict isn't mechanical. |
| 9 | Stacked PRs not enabled on repo | Drop to manual mode for the rest of this session |
| other | Unexpected | Report the error, drop to manual mode |

## Manual Mode (plain git + forge CLI)

Same verbs, no special tooling — the default whenever tooled mode isn't
available. Works with any forge (`gh`, `glab`, etc.).

### init / add

Branch each new layer from the **current top layer's tip**, never from
trunk. Name layers `<plan-basename>/t<N>` when a plan already supplies that
convention (see using-git-worktrees), otherwise `<topic>/NN-<concern>`
(e.g. `billing/01-schema`, `billing/02-api`).

```bash
git checkout <current-top-layer>
git checkout -b <next-layer>
```

### submit

Push the layer, then create its PR based on the layer below (trunk for the
bottom layer) with the forge's CLI — same "its CLI if available, or the
creation URL" fallback `finishing-a-development-branch` already uses:

```bash
git push -u origin <layer>
gh pr create --base <layer-below-or-trunk> --head <layer> --draft \
  --title "<layer summary>" --body "<see template below>"
```

Body template (every layer gets this, refreshed on each submit/sync so the
overview and merge-order markers stay accurate stack-wide):

```markdown
## This PR
<what changes in this layer only>

## Depends On
- PR #<N-1> (<layer-below>) — must merge first

## Stack Overview
1. PR #<a>: <summary> (<branch>) ← MERGE FIRST
2. PR #<b>: <summary> (<branch>) ← THIS PR
3. PR #<c>: <summary> (<branch>) — coming next
```

The bottom layer's PR has no "Depends On" section. The top layer's overview
has no "coming next" row.

### sync (cascading rebase)

Run whenever a lower layer changes (review feedback, a fixup commit):

```bash
git checkout <layer-N>
git pull

git checkout <layer-N+1>
git rebase <layer-N>
git push --force-with-lease origin <layer-N+1>
# repeat for every layer above, bottom to top
```

`--force-with-lease`, never bare `--force` — it fails safely if the remote
moved for a reason you don't know about.

### merge (sequential, one layer at a time)

```bash
# 1. Merge the bottom PR to trunk (via the forge's normal merge flow)
# 2. Retarget the next PR's base to trunk:
gh pr edit <next-pr> --base <trunk>
# 3. Merge it
# 4. Repeat up the stack
```

Never merge a middle layer's PR while it still targets the layer below —
retarget first, or the merge will include commits the reviewer never saw.

### Review isolation

There's no native Stack UI in manual mode to isolate a layer's diff for a
reviewer — call out the three-dot range explicitly when asking for review:

```bash
git diff <layer-below>...<this-layer>
```

### State tracking

Reuse the existing per-plan workspace rather than inventing a new state
file: `skills/subagent-driven-development/scripts/sdd-workspace <plan-file>`
resolves `.superagent/sdd/<plan-basename>/`, already used for the SDD
progress ledger. Add a `stack.md` there recording each layer's branch, PR
number/URL, base, and merged status.

For a stack outside SDD (a single branch stacked on request, no plan
workspace), the PR bodies' Stack Overview sections are the source of truth
— nothing else to track.

## Quick Reference

| Situation | Action |
|-----------|--------|
| gh + GitHub remote + gh-stack + feature enabled | Tooled mode |
| Any of those missing or disabled | Manual mode — still stack, just without the extension |
| New layer needed | Branch from current top layer's tip, not trunk |
| Lower layer changed | Cascade a rebase up the stack before anything else |
| Ready to land | Merge bottom-up, retargeting each next PR's base first |
| Reviewer needs isolated diff (manual mode) | `git diff <below>...<this>` |
| Independent (non-sequential) work | Not a stack — use using-git-worktrees' plain per-task flow |

## Common Rationalizations

| Excuse | Reality |
|--------|---------|
| "gh-stack isn't installed, so skip stacking" | Drop to manual mode. The mechanism changes; the default (small, chained, reviewable PRs) doesn't. |
| "Force-push is scary, just skip the rebase cascade" | `--force-with-lease` is safe — it only overwrites the remote if it matches what you last saw. A stale, unrebased stack is the actual risk. |
| "Retargeting the next PR's base is extra clicks, easier to merge everything into one" | That's exactly the single-big-PR behavior this skill replaces. Retarget and merge one layer at a time. |
| "This work is obviously one layer, no need to check" | Run Step 0 only when there's more than one dependent unit of work. A genuinely single, non-decomposable change still gets one PR — that's not this skill's job to force apart. |
| "The exit code was non-zero, but it's probably fine" | 3 means a real conflict — stop and resolve it, don't push through. 9 means the repo doesn't have the feature — drop to manual mode, don't retry the same command. |
