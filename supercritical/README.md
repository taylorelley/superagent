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
   roles, decision resolutions and specific accepted record digests. See the
   walkthrough for the complete schema.
4. Run `gate PROJECT TRUSTED_DIR`. It returns blockers or a submission digest
   for release review. The release authority records that digest and their
   identity in the protected decision. `release PROJECT TRUSTED_DIR` checks
   that authorization and emits the manifest. It publishes no executable.
   Both commands return 1 if their applicable gate is blocked. Malformed
   inputs and usage errors return 2.
5. Save the candidate object from a prior `plan` result and pass it to
   `impact PROJECT PREVIOUS_CANDIDATE` to see changed paths and required replay.
   This first build invalidates every obligation when the plan or a candidate
   file changes.

Run the gate with a trusted CLI build, immutable candidate and evidence
directories, and a trusted directory outside the project. Protect the job
configuration and evidence publication so candidate code and agents cannot
write either. The CLI checks role assignments and digests against that
directory. The CI or review system must authenticate actual identities and
establish provenance before it writes protected records. Retain the manifest,
native outputs and signed or otherwise authenticated approval records under the
project's configuration management process.

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
Machine-enforced scheduling by safety claim, protected producer authentication
for a live project, real target benches and the beginner trial remain follow-up
work.
