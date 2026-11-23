use crate::{parse, safe_path, sha, snapshot, stage_replay, Candidate, Plan, Result};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
    process::Command,
};

type Names = BTreeSet<String>;

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Work {
    #[serde(default)]
    interfaces: BTreeMap<String, Interface>,
    #[serde(default)]
    tasks: BTreeMap<String, Task>,
    log: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Interface {
    files: Names,
    obligations: Names,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Task {
    writes: Names,
    #[serde(default)]
    reads: Names,
    #[serde(default)]
    claims: Names,
    #[serde(default)]
    interfaces: Names,
    #[serde(default)]
    depends_on: Names,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorkLog {
    #[serde(default)]
    changes: BTreeMap<String, Change>,
    #[serde(default)]
    problems: BTreeMap<String, Problem>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Change {
    summary: String,
    tasks: Names,
    merged_revision: Option<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Problem {
    summary: String,
    obligations: Names,
    owner: String,
    resolution: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    issue: Option<String>,
}

#[derive(Default, Serialize)]
pub struct Schedule {
    waves: Vec<Vec<String>>,
    conflicts: BTreeMap<String, Names>,
}

fn footprint(plan: &Plan, task: &Task) -> (Names, Names) {
    let work = &plan.work;
    let mut interfaces = task.interfaces.clone();
    interfaces.extend(
        work.interfaces
            .iter()
            .filter(|(_, surface)| {
                !surface.files.is_disjoint(&task.writes) || !surface.files.is_disjoint(&task.reads)
            })
            .map(|(id, _)| id.clone()),
    );
    let mut claims = task.claims.clone();
    claims.extend(
        plan.obligations
            .iter()
            .filter(|(_, item)| {
                plan.requirements
                    .get(&item.requirement)
                    .is_some_and(|requirement| {
                        requirement
                            .implementation
                            .iter()
                            .any(|path| task.writes.contains(path))
                    })
            })
            .map(|(id, _)| id.clone()),
    );
    for name in &interfaces {
        if let Some(interface) = work.interfaces.get(name) {
            claims.extend(interface.obligations.iter().cloned());
        }
    }
    (interfaces, claims)
}

pub fn schedule(plan: &Plan) -> Result<Schedule> {
    let work = &plan.work;
    let tracked: BTreeSet<_> = plan.files.iter().collect();
    let valid_claims = |names: &Names| names.iter().all(|id| plan.obligations.contains_key(id));
    for (id, item) in &work.interfaces {
        if item.files.is_empty()
            || item.obligations.is_empty()
            || !valid_claims(&item.obligations)
            || !item.files.iter().all(|path| tracked.contains(path))
        {
            return Err(
                format!("{id}: an interface needs tracked files and known obligations").into(),
            );
        }
    }
    for (id, task) in &work.tasks {
        if task.writes.is_empty()
            || !task
                .writes
                .iter()
                .chain(&task.reads)
                .all(|path| tracked.contains(path))
            || !valid_claims(&task.claims)
            || !task
                .interfaces
                .iter()
                .all(|name| work.interfaces.contains_key(name))
            || !task
                .depends_on
                .iter()
                .all(|name| work.tasks.contains_key(name))
        {
            return Err(format!("{id}: task needs tracked edit paths and valid references").into());
        }
    }
    let footprints: BTreeMap<_, _> = work
        .tasks
        .iter()
        .map(|(id, t)| (id, footprint(plan, t)))
        .collect();
    let mut schedule = Schedule::default();
    for (id, task) in &work.tasks {
        let (interfaces, claims) = &footprints[id];
        let conflict = work
            .tasks
            .iter()
            .filter(|(other, item)| {
                *other != id
                    && (!task.writes.is_disjoint(&item.writes)
                        || !task.writes.is_disjoint(&item.reads)
                        || !task.reads.is_disjoint(&item.writes)
                        || !interfaces.is_disjoint(&footprints[*other].0)
                        || !claims.is_disjoint(&footprints[*other].1))
            })
            .map(|(other, _)| other.clone())
            .collect();
        schedule.conflicts.insert(id.clone(), conflict);
    }
    let mut done = Names::new();
    while done.len() < work.tasks.len() {
        let mut wave = Vec::new();
        for (id, task) in &work.tasks {
            if !done.contains(id)
                && task.depends_on.is_subset(&done)
                && wave
                    .iter()
                    .all(|other| !schedule.conflicts[id].contains(other))
            {
                wave.push(id.clone());
            }
        }
        if wave.is_empty() {
            return Err("task dependencies contain a cycle".into());
        }
        done.extend(wave.iter().cloned());
        schedule.waves.push(wave);
    }
    Ok(schedule)
}

#[derive(Serialize)]
pub struct Impact {
    baseline_sha256: String,
    candidate_sha256: String,
    changed_files: Names,
    plan_changed: bool,
    affected_interfaces: Names,
    replay_obligations: Names,
    release_recheck_obligations: Names,
    unmapped_files: Names,
}

pub fn impact(plan: &Plan, previous: &Candidate, current: &Candidate) -> Result<Impact> {
    schedule(plan)?;
    let changed_files: Names = previous
        .files
        .keys()
        .chain(current.files.keys())
        .filter(|path| previous.files.get(*path) != current.files.get(*path))
        .cloned()
        .collect();
    let plan_changed = previous.plan_sha256 != current.plan_sha256;
    let mut affected_interfaces = Names::new();
    let mut direct = Names::new();
    let mut unmapped_files = Names::new();
    for path in &changed_files {
        let mut mapped = false;
        for (id, interface) in &plan.work.interfaces {
            if interface.files.contains(path) {
                mapped = true;
                affected_interfaces.insert(id.clone());
                direct.extend(interface.obligations.iter().cloned());
            }
        }
        for task in plan
            .work
            .tasks
            .values()
            .filter(|task| task.writes.contains(path))
        {
            let (interfaces, claims) = footprint(plan, task);
            mapped |= !claims.is_empty();
            affected_interfaces.extend(interfaces);
            direct.extend(claims);
        }
        for (id, item) in &plan.obligations {
            if plan
                .requirements
                .get(&item.requirement)
                .is_some_and(|req| req.implementation.contains(path))
            {
                mapped = true;
                direct.insert(id.clone());
            }
        }
        if !mapped {
            unmapped_files.insert(path.clone());
        }
    }
    let release_recheck_obligations: Names = plan
        .obligations
        .keys()
        .filter(|_| plan_changed || !changed_files.is_empty())
        .cloned()
        .collect();
    let replay_obligations =
        if plan_changed || !unmapped_files.is_empty() || plan.work.interfaces.is_empty() {
            release_recheck_obligations.clone()
        } else {
            direct
        };
    Ok(Impact {
        baseline_sha256: sha(&serde_json::to_vec(previous)?),
        candidate_sha256: sha(&serde_json::to_vec(current)?),
        changed_files,
        plan_changed,
        affected_interfaces,
        replay_obligations,
        release_recheck_obligations,
        unmapped_files,
    })
}

pub fn log(root: &Path, plan: &Plan, candidate: &Candidate) -> Result<WorkLog> {
    let Some(path) = &plan.work.log else {
        return Ok(WorkLog::default());
    };
    if !candidate.files.contains_key(path) {
        return Err("work log must be tracked in candidate files".into());
    }
    let bytes = crate::read(&safe_path(root, path)?)?;
    if sha(&bytes) != candidate.files[path] {
        return Err("work log changed after snapshot".into());
    }
    let log: WorkLog = serde_json::from_slice(&bytes)?;
    for (id, change) in &log.changes {
        if change.summary.trim().is_empty()
            || change.tasks.is_empty()
            || change
                .tasks
                .iter()
                .any(|task| !plan.work.tasks.contains_key(task))
            || change
                .merged_revision
                .as_ref()
                .is_some_and(|value| value.trim().is_empty())
        {
            return Err(format!("{id}: change needs a summary and known tasks").into());
        }
    }
    for (id, report) in &log.problems {
        if report.summary.trim().is_empty()
            || report.owner.trim().is_empty()
            || report.obligations.is_empty()
            || report
                .obligations
                .iter()
                .any(|claim| !plan.obligations.contains_key(claim))
            || report
                .resolution
                .as_ref()
                .is_some_and(|value| value.trim().is_empty())
        {
            return Err(
                format!("{id}: problem needs a summary, owner and known obligations").into(),
            );
        }
    }
    Ok(log)
}

impl WorkLog {
    /// A problem's summary, owner and affected obligations.
    pub fn problem(&self, id: &str) -> Option<(&str, &str, Vec<&str>)> {
        self.problems.get(id).map(|report| {
            (
                report.summary.as_str(),
                report.owner.as_str(),
                report.obligations.iter().map(String::as_str).collect(),
            )
        })
    }

    /// Each problem report with its tracked issue, if one is recorded.
    pub fn problem_issues(&self) -> impl Iterator<Item = (&str, Option<&str>)> + '_ {
        self.problems
            .iter()
            .map(|(id, report)| (id.as_str(), report.issue.as_deref()))
    }

    pub fn blockers(&self) -> impl Iterator<Item = String> + '_ {
        self.problems
            .iter()
            .filter(|(_, report)| report.resolution.is_none())
            .map(|(id, report)| format!("{id}: open problem assigned to {}", report.owner))
    }
}

pub fn replay(root: &Path, baseline: &Path, runner: &Path) -> Result<(serde_json::Value, bool)> {
    let (plan, candidate) = snapshot(root)?;
    let report = impact(&plan, &parse(baseline)?, &candidate)?;
    let runner = runner.canonicalize()?;
    let runner_sha256 = sha(&crate::read(&runner)?);
    let mut success = true;
    let mut results = BTreeMap::new();
    for claim in &report.replay_obligations {
        let output = Command::new(&runner)
            .current_dir(root)
            .arg(claim)
            .arg(&report.candidate_sha256)
            .output()?;
        success &= output.status.success();
        let stdout = stage_replay(root, &output.stdout)?;
        let stderr = stage_replay(root, &output.stderr)?;
        results.insert(
            claim,
            json!({
                "exit_code": output.status.code(), "passed": output.status.success(),
                "stdout_sha256": stdout, "stderr_sha256": stderr,
            }),
        );
    }
    let (_, current) = snapshot(root)?;
    let changed = current != candidate;
    let runner_changed = sha(&crate::read(&runner)?) != runner_sha256;
    let result = json!({
        "impact": report, "results": results, "candidate_changed": changed,
        "runner_sha256": runner_sha256, "runner_changed": runner_changed,
    });
    let digest = stage_replay(root, &serde_json::to_vec_pretty(&result)?)?;
    Ok((
        json!({"record_sha256": digest, "run": result}),
        success && !changed && !runner_changed,
    ))
}
