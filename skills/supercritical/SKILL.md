---
name: supercritical
description: Guide requirements, assurance, verification, target validation and release for a project that has opted into Supercritical.
---

## Start with the operation

Ask the user to describe a real task, who depends on it, and what they would
observe if it went wrong. Walk through a normal case and a credible failure or
recovery case. Keep the original wording with the draft requirement. Record
what is known, where it came from, and which assumptions could change behavior.

Use the installed `supercritical` command with `plan PROJECT` to see the
candidate, draft decisions and structural blockers. With an authorized
protected evidence location, use `gate PROJECT TRUSTED_DIR` for reviewed
status. For a new project, `init PROJECT` creates a draft plan.

## Ask for a concrete decision

Describe the operational question, the consequences of plausible answers,
the evidence that would settle it, who can decide and which work depends on the
answer. Record unknowns under `decisions` and continue unaffected draft work.
Ask the system owner for the applicable project basis and allocated safety
requirements. A novice can describe the operation in their own words.

Example: If the fault input goes silent, can the interface distinguish sensor
power loss from fault clearance? Request the interface specification and the
observed behavior on the intended equipment.

## Build and verify

Use Superagent's planning, worktree and review workflow. Each task brief names
requirement and obligation IDs, expected evidence, target variants, files and
shared claims or assumptions. Serialize tasks with a shared write scope or a
shared safety claim that they can invalidate. Replay affected checks after
integration and use `impact` against the previous candidate manifest.

Default to Rust. For another language, record the basis for its use, toolchain
and verification methods. Derive test expectations from requirements. Collect
native test, proof and target observations against the exact candidate. Record
proof scope, bounds and assumptions. Submit records with `import`, or use `ingest-rust` for supported native Rust
receipts. Generate a reviewer package with `dossier` against the protected
evidence directory. Discuss
failed or unavailable checks as outstanding work and open a problem report when
the project calls for one.

## Validate and prepare release

Run reviewed scenarios with operators and equipment representative of the
intended environment. Record observations, discrepancies and restrictions.
Explain each remaining blocker and its owner. Ask the designated reviewers to
record their decisions in protected storage. A task review or passing check
does not grant approval. Only report authorized release after the release
command confirms the exact submission and manifests the files.
