# Supercritical

Supercritical is an opt-in Superagent workflow for requirements, verification
and release evidence. The same project marker enables it in OpenCode and
Claude Code. Rust is the default for product code. The policy can accept
reviewed evidence from other languages.

## Try it

From the Superagent checkout:

```sh
cargo install --locked --path supercritical
supercritical init /path/to/project
supercritical plan /path/to/project
```

Start or reload the Superagent plugin in that project and describe a real
operating scenario. The host adds Supercritical guidance. The guided workflow
asks about intended use, failed inputs, who owns each decision and what
evidence would resolve it. Use `plan` to inspect the draft and `check` to detect
missing links. The fields in `src/draft.json` and the interlock test are examples
of the input formats.

## Run the interlock walkthrough

```sh
cargo build --locked --manifest-path supercritical/Cargo.toml
python3 supercritical/tests/interlock.py supercritical/target/debug/supercritical
```

The walkthrough builds a Rust interlock, checks all eight Boolean input
tuples, runs an operator scenario against the executable, and exercises the
gate. It injects a reset defect and checks that both executable checks fail and
the prior records become stale. The approvals and roles in this fixture are
synthetic.

## Evidence and release

1. The project captures intended use, approved project basis, target,
   requirements, obligations, decisions and candidate file paths in
   `.supercritical/plan.json`. List the executable, deployment configuration
   and any source and build inputs needed to identify the candidate. Take a
   read-only snapshot with `plan PROJECT` under isolated build conditions.
2. Run project-specific checks against that snapshot. Each result records its
   obligation ID, candidate digest, producer, method, authors, outcome,
   observation, limitations and raw file digest. Archive the full invocation,
   tool versions, target, proof assumptions and native output in the raw
   artifact. Use `import PROJECT RECORD` to stage a submission. A submission
   has no approval authority.
3. In a protected job, verify the producer and review the original outputs.
   Put raw artifacts in the trusted directory using their declared relative
   paths. Publish reviewed records as `records/<record_sha256>.json`.
   `trust.json` records plan approval, producer method permissions, reviewer
   roles, decision resolutions and specific accepted record digests. Each
   sign-off cites the forge item where it was approved; see
   [Recording sign-offs from the forge](#recording-sign-offs-from-the-forge).
   See the walkthrough for the complete schema.
4. Run `gate PROJECT TRUSTED_DIR`. It returns blockers or a submission digest
   for release review. The release authority records that digest and their
   identity in the protected decision. `release PROJECT TRUSTED_DIR` checks
   that authorization and emits the manifest. It publishes no executable.
   Both commands return 1 if their applicable gate is blocked. Malformed
   inputs and usage errors return 2.
5. Save the candidate object from a prior `plan` result and pass it to
   `impact PROJECT PREVIOUS_CANDIDATE` to see changed paths and required replay.
   See the work-contract section for how the CLI prioritizes replay and
   identifies the evidence that requires review for the new candidate.

Run the gate with a trusted CLI build, immutable candidate and evidence
directories, and a trusted directory outside the project. Protect the job
configuration and evidence publication so candidate code and agents cannot
write either. The CLI checks role assignments and digests against that
directory. The CI or review system must authenticate actual identities and
establish provenance before it writes protected records. Retain the manifest,
native outputs and signed or otherwise authenticated approval records under the
project's configuration management process.

### Recording sign-offs from the forge

Every human sign-off is made in the project's forge and cited in `trust.json`.
Declare the forge in the plan:

```json
"forge": {
  "system": "github",
  "url_prefix": "https://github.com/example-org/example-project/",
  "agent_identities": ["example-agent-bot"]
}
```

`system` is `github`, `gitlab`, `azure_devops`, `gitea` or `manual`. For a
forge, `url_prefix` is the https repository URL ending in `/`. For `manual`,
it is the configuration management record prefix, such as `CM-`. A plan with
no `forge` has a structural blocker. No agent identity can hold a sign-off.

| Sign-off | Forge item | Approver | `trust.json` |
| --- | --- | --- | --- |
| Plan approval | Pull request changing `.supercritical/plan.json` | An authorized reviewer who did not open or author it | `plan_approval` beside `approved_plan` |
| Decision | Issue resolved by the owner with a written resolution, or a pull request | The decision owner | `decisions.<id>.forge` |
| Evidence acceptance | Pull request adding the record and raw artifacts to the protected evidence repository | The recorded reviewer | `acceptances.<obligation>.forge` |
| Release | Pull request carrying the submission digest | The release authority | `release.forge` |
| Problem report | Issue | The problem owner | `issue` on the work log problem |

Each `forge` value has this form:

```json
{
  "system": "github", "kind": "pull_request",
  "url": "https://github.com/example-org/example-project/pull/42", "id": "42",
  "opened_by": "example-agent-bot", "authors": ["example-engineer"],
  "approver": "example-reviewer", "approved_at": "2026-11-23T03:10:00Z",
  "revision": "<merged head commit>", "approved_revision": "<approved head commit>"
}
```

`kind` is `issue`, `pull_request` (also used for merge requests) or `record`
(only with `manual`). The gate checks that every reference is under the
prefix, has the right kind for its stage, names the same person as the role
recorded beside it, and, for a pull request, that the approved head commit is
the merged one. A push after approval therefore needs fresh approval. The
forge references are part of the submission digest the release authority
authorizes. `trust.json` version 1 is rejected: add the references and set
`version` to 2.

**Independent review.** For an obligation with `independent: true`, the
approver must not be the evidence producer, an evidence author, the pull
request opener, or a commit author or co-author. The same applies to plan
approval. Agent work counts as the work of the person who directed it. That
person is listed as an author, so they cannot independently review it.

**Requests.** `requests PROJECT [TRUSTED_DIR]` lists the forge items the
project still needs, with title, body, labels, branch, approver role and
independence. Without a trusted directory, it lists everything that needs a
sign-off. With one, it lists only what the gate still blocks on, and offers
the release item once the gate is clear. Agents raise these items through the
shared skill and stop. While a project has a plan, both hosts deny Superagent's
agents the forge commands that approve, merge or close, and edits to
`trust.json` and staged records. Pattern matching cannot catch every route to
a forge, so branch protection and the gate are the enforcement.

**Protected CI.** The CLI never contacts the forge. A protected job, triggered
when a labelled item is merged or closed, reads the approval with the forge
API. It checks the approver against the roles and, for independent items,
against the opener and commit authors. Then it writes the reference.
[`examples/forge-signoff.yml`](examples/forge-signoff.yml) shows the shape for
GitHub Actions. On GitLab, use merge request approval rules and a protected
pipeline. On Azure DevOps, use branch policies and a pipeline. On Gitea or
Forgejo, use Actions. Configure the forge so that its own rules match the
gate: required approvers, no approval by authors or committers, and approvals
dismissed on new commits. See `skills/supercritical/forges.md`.

### Safety Analysis Toolkit

Use the toolkit to collect and interpret native verifier output. For Rust,
run its reviewed snapshot and proof import workflow, compare against the
reviewed baseline when applicable, and archive the toolkit JSON report and
proof scope as the raw evidence artifact. A producer and reviewer translate the
specific property outcome into a Supercritical record. The gate checks that
record and its raw artifact against protected acceptance. C/C++ static
analysis and target test output can enter via the same record contract.
[Toolkit Rust workflow](https://github.com/taylorelley/safety-analysis-toolkit/blob/main/docs/rust-proof-import.md)

### Automated Rust intake and reviewer dossier

Add a `rust_checks` entry to the plan for each mapped obligation. Use
`{"type":"kani","property":"REQ-KEEP@host"}` for a toolkit Kani/CBMC property
or `{"type":"libtest","test":"tests::reset_during_fault_keeps_inhibit"}` for a
test case. Set each obligation's method to `proof` or `test` respectively.
Capture one native libtest JSON suite with the pinned nightly. Run the toolkit
Rust importer and retain its stdout JSON, input bundle, native artifacts and
any counterexample file. The candidate file list must cover the toolkit input
inventory, including `rust-verification.json`. The CLI handles the
Supercritical plan and the toolkit input bundle as separate digests.

Create a producer receipt with the pre-run candidate digest, producer and
author identities, captured exit statuses, paths relative to the project, and
artifact digests. The replay script shows the exact schema and how to capture
command and toolchain provenance. Ingest before moving the reviewed records and
their artifacts to protected storage.

```sh
supercritical ingest-rust PROJECT .safety/receipt.json
supercritical dossier PROJECT TRUSTED_DIR > dossier.json
```

Intake emits staged submissions for successful and unsuccessful checks. Exit
1 means at least one mapped check is incomplete or failed. Exit 2 means the
receipt or captures could not be ingested. Keep the native proof plan under
review. The adapter verifies agreement across records and does not grant
producer identity or acceptance. In protected CI, authenticate the producing
job and review the results before recording acceptance.

The dossier uses the same rules as `gate` and includes the candidate manifest,
requirement-to-obligation links, proof scopes, artifact hashes, recorded review
decisions, open blockers and the release decision. Define optional
`objectives` with a description and obligation IDs to produce the project
objective matrix. Its entries reflect the project's mapping. The dossier is
also emitted for a blocked candidate and uses exit 1 in that case.

The **Supercritical native evidence** workflow runs the pinned toolkit and
Kani/CBMC against the reference and mutated interlocks and archives both
dossiers. Its synthetic approvals are isolated from production release.
Protected producer authentication for a live project, real target benches
and the beginner trial remain follow-up work.

### Work contracts and merge replay

Add optional `work.interfaces` to map reviewed interface file paths to
obligation IDs. Add `work.tasks` with exact candidate paths under `writes`,
optional `reads`, and optional `interfaces`, `claims` and `depends_on`.
`schedule PROJECT` returns deterministic waves. File read/write overlap,
shared interfaces and shared claims keep tasks in separate waves. Interface
membership is also inferred from declared paths. Both agent hosts use the
same plan and CLI through the shared skill.

Save the reviewed candidate from `plan PROJECT` before the work begins. On
the merged checkout, run:

```sh
supercritical impact PROJECT BEFORE.json
supercritical replay PROJECT BEFORE.json /path/to/project-ci-runner
```

The runner is an explicitly selected executable that receives the obligation
ID and merged candidate digest as arguments and runs from the project root.
Give it a deterministic dispatch for each obligation, including how to handle
unavailable checks. The CLI archives stdout, stderr and a content-addressed
run record under `.supercritical/replays`, and reports a failed runner or
candidate drift with exit 1. Use an isolated checkout and producer environment.
The replay records do not carry protected review decisions.

Mapped file changes select a focused replay. Plan changes, unmapped paths and
projects without interface mappings select all obligations. The
`release_recheck_obligations` list remains conservative. A change to the
candidate digest requires current accepted evidence for release even if
focused replay prioritizes only part of the suite.

Set `work.log` to a tracked JSON file listed in `files`. Its `changes` map
records summaries, task IDs and optional merged revisions. Its `problems` map
records summaries, owners, affected obligation IDs and an optional written
resolution. Keep entries under stable IDs in version control. Unresolved
problems block the gate. The dossier includes both maps so a resumed session
can continue from recorded work. A written resolution still requires current
reviewed evidence to close its obligations.
