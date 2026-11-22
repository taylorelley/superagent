#![forbid(unsafe_code)]

mod model;

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
    if item.outcome != Outcome::Pass || file_digest(root, &item.raw_path)? != item.raw_sha256 {
        return Err("run is unsuccessful or the raw evidence digest differs".into());
    }
    Ok(())
}

fn gate(root: &Path, trusted: &Path) -> Result<Gate> {
    if trusted.canonicalize()?.starts_with(root.canonicalize()?) {
        return Err("use a protected evidence directory outside the candidate project".into());
    }
    let (mut plan, candidate) = snapshot(root)?;
    let candidate_sha256 = sha(&serde_json::to_vec(&candidate)?);
    let trust: Trust = parse(&safe_path(trusted, "trust.json")?)?;
    if trust.version != 1 {
        return Err("unsupported trust version".into());
    }
    let mut blockers = check_plan(&plan, &candidate);
    if trust.approved_plan != candidate.plan_sha256 {
        blockers.push("The protected plan approval does not match the current plan".into());
    }
    let mut resolutions = BTreeMap::new();
    plan.decisions.retain(|id, decision| {
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
        }
        !accepted
    });
    let mut accepted = BTreeMap::new();
    for (id, obligation) in &plan.obligations {
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
            valid_record(&item, id, obligation, &candidate_sha256, &trust, trusted)?;
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
            Err(error) => blockers.push(format!("{id}: {error}")),
        }
    }
    let submission_sha256 = blockers
        .is_empty()
        .then(|| {
            serde_json::to_vec(&(
                &candidate_sha256,
                accepted,
                resolutions,
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
    Ok(Gate {
        candidate_sha256,
        submission_sha256,
        status,
        blockers,
        pending_decisions: plan.decisions,
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
            let blockers = check_plan(&plan, &candidate);
            print(&serde_json::json!({
                "candidate_sha256": sha(&serde_json::to_vec(&candidate)?),
                "candidate": candidate,
                "blockers": blockers,
                "decisions": plan.decisions,
            }))?;
            return Ok(if command == "check" && !blockers.is_empty() { 1 } else { 0 });
        }
        [command, root, previous] if command == "impact" => {
            let baseline: Candidate = parse(Path::new(previous))?;
            let (plan, current) = snapshot(Path::new(root))?;
            let files: BTreeSet<_> = baseline.files.keys().chain(current.files.keys())
                .filter(|path| baseline.files.get(*path) != current.files.get(*path)).collect();
            let changed = baseline.plan_sha256 != current.plan_sha256 || !files.is_empty();
            let replay: Vec<_> = plan.obligations.keys().filter(|_| changed).collect();
            print(&serde_json::json!({"changed_files": files, "plan_changed": baseline.plan_sha256 != current.plan_sha256, "replay_obligations": replay}))?;
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
            if file_digest(Path::new(root), &evidence.raw_path)? != evidence.raw_sha256 {
                return Err("raw evidence digest differs".into());
            }
            let digest = sha(&bytes);
            let directory = Path::new(root).join(PROJECT).join("records");
            fs::create_dir_all(&directory)?;
            let path = directory.join(format!("{digest}.json"));
            match write_new(&path, &bytes) {
                Ok(()) => (),
                Err(error) if read(&path).ok().as_deref() == Some(&bytes) => drop(error),
                Err(error) => return Err(error),
            }
            print(&serde_json::json!({"record_sha256": digest, "path": path, "status": "submitted"}))?;
        }
        [command, root, trusted] if command == "gate" || command == "release" => {
            let verdict = gate(Path::new(root), Path::new(trusted))?;
            let status = verdict.status;
            if command == "release" && status == "authorized" {
                let (_, manifest) = snapshot(Path::new(root))?;
                if sha(&serde_json::to_vec(&manifest)?) != verdict.candidate_sha256 {
                    return Err("candidate changed during release".into());
                }
                print(&serde_json::json!({"decision": verdict, "manifest": manifest}))?;
            } else {
                print(&verdict)?;
            }
            return Ok(u8::from(status == "blocked" || (command == "release" && status != "authorized")));
        }
        _ => return Err("usage: supercritical init|plan|check PROJECT; impact PROJECT PREVIOUS_CANDIDATE; import PROJECT RECORD; gate|release PROJECT TRUSTED_DIR".into()),
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
