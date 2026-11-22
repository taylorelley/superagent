use crate::model::{Evidence, Method, Outcome, RustCheck};
use crate::{file_digest, read, safe_path, sha, snapshot, stage, Candidate, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Receipt {
    version: u32,
    candidate_sha256: String,
    producer: String,
    authors: Vec<String>,
    toolkit: Option<ToolkitCapture>,
    libtest: Option<Capture>,
    #[serde(default)]
    artifacts: BTreeMap<String, String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Capture {
    path: String,
    sha256: String,
    exit_code: i32,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ToolkitCapture {
    report: Capture,
    bundle_input: String,
    artifacts: BTreeMap<String, String>,
}

#[derive(Deserialize)]
struct ToolkitRun {
    schema_version: u32,
    operation: String,
    id: String,
    status: String,
    complete: bool,
    inputs: BTreeMap<String, String>,
    verification: Value,
    properties: Vec<Property>,
    limitations: Vec<String>,
}

#[derive(Deserialize)]
struct Property {
    id: String,
    description: String,
    outcome: String,
    scope: String,
    assumptions: Vec<String>,
    unwind_bound: Option<u32>,
    completeness_established: bool,
    native_references: Vec<String>,
}

fn capture(root: &Path, input: &Capture) -> Result<Vec<u8>> {
    let data = read(&safe_path(root, &input.path)?)?;
    if sha(&data) != input.sha256 {
        return Err(format!("capture digest differs: {}", input.path).into());
    }
    Ok(data)
}

fn toolkit(
    root: &Path,
    item: &ToolkitCapture,
    candidate: &Candidate,
    producer: &str,
) -> Result<ToolkitRun> {
    let report: ToolkitRun = serde_json::from_slice(&capture(root, &item.report)?)?;
    if report.schema_version != 1
        || report.operation != "rust-import"
        || report.verification["producer"].as_str() != Some(producer)
        || report.verification["origin"] != "supplied_ci_record"
        || item.bundle_input == ".supercritical/plan.json"
        || candidate.files.contains_key(&item.bundle_input)
    {
        return Err("unexpected toolkit report or producer".into());
    }
    if report.inputs.get(&item.bundle_input) != item.artifacts.get(&item.bundle_input)
        || !item.artifacts.contains_key(&item.bundle_input)
    {
        return Err("toolkit input bundle must be retained as evidence".into());
    }
    let mut inputs = report.inputs.clone();
    inputs.remove(&item.bundle_input);
    let mut expected = candidate.files.clone();
    expected.insert(
        ".supercritical/plan.json".into(),
        candidate.plan_sha256.clone(),
    );
    if inputs != expected || !expected.contains_key("rust-verification.json") {
        return Err("toolkit inputs differ from the candidate inventory".into());
    }
    for (path, digest) in &item.artifacts {
        if &file_digest(root, path)? != digest {
            return Err(format!("toolkit artifact digest differs: {path}").into());
        }
    }
    let code = match (report.status.as_str(), report.complete) {
        ("passed", true) => 0,
        ("findings", true) => 1,
        ("incomplete", false) => 3,
        _ => return Err("invalid toolkit completion status".into()),
    };
    if code != item.report.exit_code {
        return Err("toolkit exit status differs from the report".into());
    }
    Ok(report)
}

fn libtest(bytes: &[u8], exit_code: i32) -> Result<BTreeMap<String, String>> {
    let mut started = BTreeSet::new();
    let mut outcomes = BTreeMap::new();
    let (mut count, mut suite_end) = (None, None);
    for line in std::str::from_utf8(bytes)?.lines() {
        let event: Value = serde_json::from_str(line)?;
        let kind = event["event"].as_str().ok_or("libtest event missing")?;
        match (event["type"].as_str(), kind) {
            (Some("suite"), "started") if count.is_none() => count = event["test_count"].as_u64(),
            (Some("test"), "started") if count.is_some() && suite_end.is_none() => {
                let name = event["name"].as_str().ok_or("test name missing")?;
                if !started.insert(name.to_owned()) {
                    return Err("duplicate test start".into());
                }
            }
            (Some("test"), "ok" | "failed" | "ignored")
                if count.is_some() && suite_end.is_none() =>
            {
                let name = event["name"]
                    .as_str()
                    .ok_or("test name missing")?
                    .to_owned();
                if (!started.contains(&name) && kind != "ignored")
                    || outcomes.insert(name, kind.to_owned()).is_some()
                {
                    return Err("unexpected libtest outcome".into());
                }
            }
            (Some("suite"), "ok" | "failed") if count.is_some() && suite_end.is_none() => {
                suite_end = Some(event);
            }
            _ => return Err("unexpected libtest event".into()),
        }
    }
    let summary = suite_end.ok_or("libtest terminal summary missing")?;
    for (field, kind) in [
        ("passed", "ok"),
        ("failed", "failed"),
        ("ignored", "ignored"),
    ] {
        if summary[field].as_u64()
            != Some(outcomes.values().filter(|v| v.as_str() == kind).count() as u64)
        {
            return Err("libtest summary differs from the test outcomes".into());
        }
    }
    let failed = outcomes.values().any(|v| v == "failed");
    if count != Some(outcomes.len() as u64)
        || started.iter().any(|name| !outcomes.contains_key(name))
        || (failed && (exit_code != 101 || summary["event"] != "failed"))
        || (!failed && (exit_code != 0 || summary["event"] != "ok"))
    {
        return Err("incomplete or inconsistent libtest run".into());
    }
    Ok(outcomes)
}

pub fn ingest(root: &Path, receipt_path: &str) -> Result<(Value, bool)> {
    let raw = read(&safe_path(root, receipt_path)?)?;
    let receipt: Receipt = serde_json::from_slice(&raw)?;
    let (plan, candidate) = snapshot(root)?;
    let candidate_sha256 = sha(&serde_json::to_vec(&candidate)?);
    if receipt.version != 1
        || receipt.candidate_sha256 != candidate_sha256
        || receipt.producer.trim().is_empty()
        || receipt.authors.is_empty()
        || receipt.authors.iter().any(|s| s.trim().is_empty())
        || plan.rust_checks.is_empty()
    {
        return Err("invalid Rust receipt or candidate scope".into());
    }
    let proof = receipt
        .toolkit
        .as_ref()
        .map(|item| toolkit(root, item, &candidate, &receipt.producer))
        .transpose()?;
    let tests = receipt
        .libtest
        .as_ref()
        .map(|item| libtest(&capture(root, item)?, item.exit_code))
        .transpose()?;
    for (path, digest) in &receipt.artifacts {
        if &file_digest(root, path)? != digest {
            return Err(format!("producer artifact digest differs: {path}").into());
        }
    }
    let mut all_passed = true;
    let mut records = BTreeMap::new();
    for (id, check) in &plan.rust_checks {
        let obligation = plan
            .obligations
            .get(id)
            .ok_or("Rust check refers to an unknown obligation")?;
        let mut artifacts = receipt.artifacts.clone();
        let (method, outcome, observed, limitations, details) = match check {
            RustCheck::Kani { property } => {
                let run = proof.as_ref().ok_or("toolkit report required")?;
                let imported = receipt.toolkit.as_ref().ok_or("toolkit capture required")?;
                artifacts.extend(imported.artifacts.clone());
                artifacts.insert(imported.report.path.clone(), imported.report.sha256.clone());
                let matches: Vec<_> = run
                    .properties
                    .iter()
                    .filter(|p| p.id == *property)
                    .collect();
                let [item] = matches.as_slice() else {
                    return Err(format!("{id}: expected one toolkit property {property}").into());
                };
                if !item
                    .description
                    .starts_with(&format!("{}: ", obligation.requirement))
                    || !item.scope.starts_with("Kani/CBMC harness ")
                    || !item.unwind_bound.is_some_and(|bound| bound > 0)
                    || item.native_references.is_empty()
                {
                    return Err(format!("{id}: property requirement or model scope differs").into());
                }
                let directory = Path::new(&imported.report.path)
                    .parent()
                    .ok_or("invalid report path")?;
                for reference in &item.native_references {
                    let filename = reference.split('#').next().unwrap_or_default();
                    let path = directory.join(filename);
                    if !path
                        .to_str()
                        .is_some_and(|file| artifacts.contains_key(file))
                    {
                        return Err(format!("{id}: missing native artifact {filename}").into());
                    }
                }
                if item.outcome == "VIOLATED" {
                    let path = directory.join("counterexamples.json");
                    let path = path.to_str().ok_or("invalid counterexample path")?;
                    if !artifacts.contains_key(path) {
                        return Err(format!("{id}: missing counterexample archive").into());
                    }
                    let witnesses: Vec<Value> =
                        serde_json::from_slice(&read(&safe_path(root, path)?)?)?;
                    if !witnesses.iter().any(|w| {
                        w["property_id"].as_str() == Some(property)
                            && w["status"] == "VIOLATED"
                            && w["steps"].as_array().is_some_and(|steps| !steps.is_empty())
                    }) {
                        return Err(format!("{id}: missing counterexample for {property}").into());
                    }
                }
                let outcome = match item.outcome.as_str() {
                    "PROVEN"
                        if run.complete
                            && run.status == "passed"
                            && item.completeness_established =>
                    {
                        Outcome::Pass
                    }
                    "VIOLATED" => Outcome::Fail,
                    _ => Outcome::Incomplete,
                };
                (
                    Method::Proof,
                    outcome,
                    item.description.clone(),
                    run.limitations.join("\n"),
                    json!({"run_id": run.id, "property": item.id, "verifier_outcome": item.outcome,
                        "scope": item.scope, "assumptions": item.assumptions, "unwind_bound": item.unwind_bound,
                        "native_references": item.native_references, "complete": run.complete}),
                )
            }
            RustCheck::Libtest { test } => {
                let run = tests.as_ref().ok_or("libtest capture required")?;
                let imported = receipt.libtest.as_ref().ok_or("libtest capture required")?;
                artifacts.insert(imported.path.clone(), imported.sha256.clone());
                let outcome = match run.get(test).map(String::as_str) {
                    Some("ok") if imported.exit_code == 0 => Outcome::Pass,
                    Some("failed") => Outcome::Fail,
                    _ => Outcome::Incomplete,
                };
                (
                    Method::Test,
                    outcome,
                    format!(
                        "Rust test {test}: {}",
                        run.get(test).map_or("missing", String::as_str)
                    ),
                    "Result applies to the captured test executable".into(),
                    json!({"test": test, "exit_code": imported.exit_code}),
                )
            }
        };
        if method != obligation.method {
            return Err(format!("{id}: Rust check method differs from the obligation").into());
        }
        all_passed &= outcome == Outcome::Pass;
        records.insert(
            id,
            Evidence {
                obligation: id.clone(),
                candidate_sha256: candidate_sha256.clone(),
                method,
                producer: receipt.producer.clone(),
                authors: receipt.authors.clone(),
                outcome,
                raw_path: receipt_path.to_owned(),
                raw_sha256: sha(&raw),
                observed,
                limitations,
                details: Some(details),
                artifacts,
            },
        );
    }
    let mut submissions = BTreeMap::new();
    for (id, record) in records {
        let mut submission = stage(root, &serde_json::to_vec(&record)?)?;
        submission["outcome"] = serde_json::to_value(record.outcome)?;
        submissions.insert(id, submission);
    }
    Ok((
        json!({"candidate_sha256": candidate_sha256, "submissions": submissions}),
        all_passed,
    ))
}
