#![forbid(unsafe_code)]

mod model;
mod rust_evidence;
mod work;

use model::*;
use serde::{de::DeserializeOwned, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    env, fs,
    io::{self, Write},
    path::{Component, Path, PathBuf},
    process::ExitCode,
};

type Result<T> = std::result::Result<T, Box<dyn std::error::Error>>;

const PROJECT: &str = ".supercritical";
const DRAFT: &str = include_str!("draft.json");

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn read(path: &Path) -> Result<Vec<u8>> {
    fs::read(path).map_err(|error| format!("{}: {error}", path.display()).into())
}

fn parse<T: DeserializeOwned>(path: &Path) -> Result<T> {
    serde_json::from_slice(&read(path)?)
        .map_err(|error| format!("{}: {error}", path.display()).into())
}

fn print(value: &impl Serialize) -> Result<()> {
    serde_json::to_writer_pretty(io::stdout().lock(), value)?;
    println!();
    Ok(())
}

fn safe_path(root: &Path, relative: &str) -> Result<PathBuf> {
    let relative = Path::new(relative);
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err(format!("expected a project-relative file: {}", relative.display()).into());
    }
    let root = root.canonicalize()?;
    let candidate = root.join(relative).canonicalize()?;
    if !candidate.starts_with(&root) || !candidate.is_file() {
        return Err(format!("file is outside its evidence root: {}", relative.display()).into());
    }
    Ok(candidate)
}

fn file_digest(root: &Path, relative: &str) -> Result<String> {
    let mut file = fs::File::open(safe_path(root, relative)?)?;
    let mut digest = Sha256::new();
    io::copy(&mut file, &mut digest)?;
    Ok(format!("{:x}", digest.finalize()))
}

fn snapshot(root: &Path) -> Result<(Plan, Candidate)> {
    let path = safe_path(root, ".supercritical/plan.json")?;
    let bytes = read(&path)?;
    let plan: Plan = serde_json::from_slice(&bytes)?;
    if plan.version != 1 {
        return Err("unsupported plan version".into());
    }
    let mut files = BTreeMap::new();
    for name in &plan.files {
        if files
            .insert(name.clone(), file_digest(root, name)?)
            .is_some()
        {
            return Err(format!("duplicate candidate file: {name}").into());
        }
    }
    Ok((
        plan,
        Candidate {
            plan_sha256: sha(&bytes),
            files,
        },
    ))
}

fn check_plan(plan: &Plan, candidate: &Candidate) -> Vec<String> {
    let mut blockers = Vec::new();
    if [&plan.intended_use, &plan.target, &plan.approval_basis]
        .iter()
        .any(|s| s.trim().is_empty())
    {
        blockers.push("Describe the intended use, target and approved project basis".into());
    }
    if plan.requirements.is_empty() || plan.obligations.is_empty() || candidate.files.is_empty() {
        blockers.push("Record requirements, evidence obligations and candidate files".into());
    }
    for (id, requirement) in &plan.requirements {
        if requirement.source.trim().is_empty()
            || requirement.behavior.trim().is_empty()
            || requirement.implementation.is_empty()
            || requirement
                .implementation
                .iter()
                .any(|file| !candidate.files.contains_key(file))
        {
            blockers.push(format!(
                "{id}: record a source, behavior and candidate file mapping"
            ));
        }
        if !plan
            .obligations
            .values()
            .any(|item| item.requirement == *id)
        {
            blockers.push(format!("{id}: plan evidence for this requirement"));
        }
    }
    for (id, obligation) in &plan.obligations {
        if !plan.requirements.contains_key(&obligation.requirement)
            || obligation.criterion.trim().is_empty()
        {
            blockers.push(format!(
                "{id}: link a requirement and define an acceptance criterion"
            ));
        }
    }
    for (id, decision) in &plan.decisions {
        if decision.affected_requirements.is_empty()
            || decision
                .affected_requirements
                .iter()
                .any(|id| !plan.requirements.contains_key(id))
            || [
                &decision.question,
                &decision.consequence,
                &decision.evidence_needed,
                &decision.owner,
            ]
            .iter()
            .any(|s| s.trim().is_empty())
        {
            blockers.push(format!(
                "{id}: record the question, impact, evidence, owner and affected requirements"
            ));
        }
    }
    if !plan
        .obligations
        .values()
        .any(|item| item.method == Method::TargetValidation)
    {
        blockers.push("Plan validation for the stated target and intended use".into());
    }
    for (id, objective) in &plan.objectives {
        if objective.description.trim().is_empty()
            || objective.obligations.is_empty()
            || objective
                .obligations
                .iter()
                .any(|id| !plan.obligations.contains_key(id))
        {
            blockers.push(format!(
                "{id}: describe the objective and link valid obligations"
            ));
        }
    }
    if let Err(error) = work::schedule(plan) {
        blockers.push(error.to_string());
    }
    blockers
}

fn valid_record(
    item: &Evidence,
    id: &str,
    obligation: &Obligation,
    candidate: &str,
    trust: &Trust,
    root: &Path,
) -> Result<()> {
    if item.obligation != id
        || item.candidate_sha256 != candidate
        || item.method != obligation.method
    {
        return Err("evidence scope does not match the obligation and candidate".into());
    }
    if item.observed.trim().is_empty()
        || item.authors.is_empty()
        || item.authors.iter().any(|id| id.trim().is_empty())
    {
        return Err("record the observation and authors".into());
    }
    if !trust
        .producers
        .get(&item.producer)
        .is_some_and(|methods| methods.contains(&item.method))
    {
        return Err("producer is not authorized for this method".into());
    }
    if item.outcome != Outcome::Pass {
        return Err("run is unsuccessful".into());
    }
    if !evidence_integrity(root, item)? {
        return Err("run is unsuccessful or the raw evidence digest differs".into());
    }
    Ok(())
}

fn evidence_integrity(root: &Path, item: &Evidence) -> Result<bool> {
    if file_digest(root, &item.raw_path)? != item.raw_sha256 {
        return Ok(false);
    }
    for (path, expected) in &item.artifacts {
        if &file_digest(root, path)? != expected {
            return Ok(false);
        }
    }
    Ok(true)
}

fn dossier(root: &Path, trusted: &Path) -> Result<Dossier> {
    if trusted.canonicalize()?.starts_with(root.canonicalize()?) {
        return Err("use a protected evidence directory outside the candidate project".into());
    }
    let (plan, candidate) = snapshot(root)?;
    let candidate_sha256 = sha(&serde_json::to_vec(&candidate)?);
    let trust: Trust = parse(&safe_path(trusted, "trust.json")?)?;
    if trust.version != 1 {
        return Err("unsupported trust version".into());
    }
    let mut blockers = check_plan(&plan, &candidate);
    let work_log = work::log(root, &plan, &candidate)?;
    blockers.extend(work_log.blockers());
    if trust.approved_plan != candidate.plan_sha256 {
        blockers.push("The protected plan approval does not match the current plan".into());
    }
    let mut resolutions = BTreeMap::new();
    let mut pending_decisions = BTreeMap::new();
    for (id, decision) in &plan.decisions {
        let accepted = trust.decisions.get(id).is_some_and(|resolution| {
            resolution.owner == decision.owner
                && trust.decision_owners.contains(&resolution.owner)
                && !resolution.resolution.trim().is_empty()
                && !resolution.source.trim().is_empty()
        });
        if accepted {
            let resolution = &trust.decisions[id];
            resolutions.insert(
                id.clone(),
                [
                    &resolution.owner,
                    &resolution.resolution,
                    &resolution.source,
                ],
            );
        } else {
            blockers.push(format!("{id}: decision needed from {}", decision.owner));
            pending_decisions.insert(id.clone(), decision.clone());
        }
    }
    let mut evidence = BTreeMap::new();
    let mut accepted = BTreeMap::new();
    for (id, obligation) in &plan.obligations {
        let mut row = EvidenceReview {
            acceptance: trust.acceptances.get(id).cloned(),
            result: None,
            blocker: None,
        };
        let result = (|| -> Result<_> {
            let approval = trust
                .acceptances
                .get(id)
                .ok_or("reviewed evidence is missing")?;
            if !trust.reviewers.contains(&approval.reviewer) {
                return Err("reviewer is not authorized".into());
            }
            let digest = &approval.record_sha256;
            if digest.len() != 64
                || !digest
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                return Err("invalid evidence record digest".into());
            }
            let bytes = read(&safe_path(trusted, &format!("records/{digest}.json"))?)?;
            if sha(&bytes) != *digest {
                return Err("evidence record digest differs".into());
            }
            let item: Evidence = serde_json::from_slice(&bytes)?;
            row.result = Some(item);
            let item = row.result.as_ref().expect("just loaded");
            valid_record(item, id, obligation, &candidate_sha256, &trust, trusted)?;
            if obligation.independent
                && (item.authors.contains(&approval.reviewer) || item.producer == approval.reviewer)
            {
                return Err("independent review requires a different reviewer".into());
            }
            Ok([&approval.reviewer, digest])
        })();
        match result {
            Ok(record) => {
                accepted.insert(id, record);
            }
            Err(error) => {
                row.blocker = Some(error.to_string());
                blockers.push(format!("{id}: {error}"));
            }
        }
        evidence.insert(id.clone(), row);
    }
    let submission_sha256 = blockers
        .is_empty()
        .then(|| {
            serde_json::to_vec(&(
                &candidate_sha256,
                accepted,
                &resolutions,
                &trust.producers,
                &trust.reviewers,
                &trust.decision_owners,
                &trust.release_authorities,
            ))
        })
        .transpose()?
        .map(|bytes| sha(&bytes));
    let status = match &submission_sha256 {
        None => "blocked",
        Some(digest)
            if trust.release.as_ref().is_some_and(|release| {
                trust.release_authorities.contains(&release.authority)
                    && &release.submission_sha256 == digest
            }) =>
        {
            "authorized"
        }
        Some(_) => "ready_for_release_review",
    };
    let resolved_ids: BTreeSet<_> = resolutions.into_keys().collect();
    let resolved_decisions = trust
        .decisions
        .into_iter()
        .filter(|(id, _)| resolved_ids.contains(id))
        .collect();
    let trace = plan
        .requirements
        .keys()
        .map(|id| {
            let claims = plan
                .obligations
                .iter()
                .filter(|(_, item)| &item.requirement == id)
                .map(|(key, _)| key.clone())
                .collect();
            (id.clone(), claims)
        })
        .collect();
    let objectives = plan
        .objectives
        .iter()
        .map(|(id, objective)| {
            let blockers = objective
                .obligations
                .iter()
                .filter(|claim| evidence.get(*claim).is_none_or(|row| row.blocker.is_some()))
                .cloned()
                .collect();
            (id.clone(), ObjectiveReview { blockers })
        })
        .collect();
    Ok(Dossier {
        decision: Gate {
            candidate_sha256,
            submission_sha256,
            status,
            blockers,
            pending_decisions,
        },
        candidate,
        plan,
        evidence,
        trace,
        objectives,
        resolved_decisions,
        release_authorization: trust.release,
        work_log,
    })
}

fn write_new(path: &Path, contents: &[u8]) -> Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(contents)?;
    file.sync_all()?;
    Ok(())
}

fn stage(root: &Path, bytes: &[u8]) -> Result<serde_json::Value> {
    let digest = sha(bytes);
    let directory = root.join(PROJECT).join("records");
    fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{digest}.json"));
    match write_new(&path, bytes) {
        Ok(()) => (),
        Err(_) if read(&path).ok().as_deref() == Some(bytes) => (),
        Err(error) => return Err(error),
    }
    Ok(serde_json::json!({"record_sha256": digest, "path": path, "status": "submitted"}))
}

fn stage_replay(root: &Path, bytes: &[u8]) -> Result<String> {
    let digest = sha(bytes);
    let directory = root.join(PROJECT).join("replays");
    fs::create_dir_all(&directory)?;
    let path = directory.join(&digest);
    match write_new(&path, bytes) {
        Ok(()) => (),
        Err(_) if read(&path).ok().as_deref() == Some(bytes) => (),
        Err(error) => return Err(error),
    }
    Ok(digest)
}

fn run(args: &[String]) -> Result<u8> {
    match args {
        [command, root] if command == "init" => {
            let directory = Path::new(root).join(PROJECT);
            fs::create_dir_all(&directory)?;
            write_new(&directory.join("plan.json"), DRAFT.as_bytes())?;
            print(&serde_json::json!({"plan": directory.join("plan.json"), "status":"draft"}))?;
        }
        [command, root] if command == "plan" || command == "check" => {
            let (plan, candidate) = snapshot(Path::new(root))?;
            let mut blockers = check_plan(&plan, &candidate);
            let work_log = work::log(Path::new(root), &plan, &candidate)?;
            blockers.extend(work_log.blockers());
            print(&serde_json::json!({
                "candidate_sha256": sha(&serde_json::to_vec(&candidate)?),
                "candidate": candidate,
                "blockers": blockers,
                "decisions": plan.decisions,
                "work_log": work_log,
            }))?;
            return Ok(if command == "check" && !blockers.is_empty() { 1 } else { 0 });
        }
        [command, root] if command == "schedule" => {
            let (plan, _) = snapshot(Path::new(root))?;
            print(&work::schedule(&plan)?)?;
        }
        [command, root, previous] if command == "impact" => {
            let baseline = parse(Path::new(previous))?;
            let (plan, current) = snapshot(Path::new(root))?;
            print(&work::impact(&plan, &baseline, &current)?)?;
        }
        [command, root, previous, runner] if command == "replay" => {
            let (report, passed) = work::replay(Path::new(root), Path::new(previous), Path::new(runner))?;
            print(&report)?;
            return Ok(u8::from(!passed));
        }
        [command, root, record] if command == "import" => {
            let (plan, candidate) = snapshot(Path::new(root))?;
            let bytes = read(Path::new(record))?;
            let evidence: Evidence = serde_json::from_slice(&bytes)?;
            let obligation = plan.obligations.get(&evidence.obligation).ok_or("unknown obligation")?;
            if evidence.candidate_sha256 != sha(&serde_json::to_vec(&candidate)?)
                || obligation.method != evidence.method {
                return Err("evidence belongs to a different candidate or method".into());
            }
            if !evidence_integrity(Path::new(root), &evidence)? {
                return Err("raw evidence digest differs".into());
            }
            print(&stage(Path::new(root), &bytes)?)?;
        }
        [command, root, receipt] if command == "ingest-rust" => {
            let (output, all_passed) = rust_evidence::ingest(Path::new(root), receipt)?;
            print(&output)?;
            return Ok(u8::from(!all_passed));
        }

        [command, root, trusted] if matches!(command.as_str(), "gate" | "release" | "dossier") => {
            let report = dossier(Path::new(root), Path::new(trusted))?;
            let status = report.decision.status;
            if command == "dossier" {
                print(&report)?;
            } else if command == "release" && status == "authorized" {
                print(&serde_json::json!({"decision": report.decision, "manifest": report.candidate}))?;
            } else {
                print(&report.decision)?;
            }
            return Ok(u8::from(status == "blocked" || (command == "release" && status != "authorized")));
        }
        _ => return Err("usage: supercritical init|plan|check|schedule PROJECT; replay PROJECT PREVIOUS_CANDIDATE RUNNER; impact PROJECT PREVIOUS_CANDIDATE; import PROJECT RECORD; ingest-rust PROJECT RECEIPT; gate|release|dossier PROJECT TRUSTED_DIR".into()),
    }
    Ok(0)
}

fn main() -> ExitCode {
    match run(&env::args().skip(1).collect::<Vec<_>>()) {
        Ok(status) => status.into(),
        Err(error) => {
            eprintln!("{error}");
            ExitCode::from(2)
        }
    }
}
