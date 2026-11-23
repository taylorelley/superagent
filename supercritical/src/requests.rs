//! The forge items a project should raise now, so every review and approval
//! is requested through its issue tracker or pull requests with the same
//! content. Read-only: the agent raises each item and stops.

use crate::{check_plan, dossier, sha, snapshot, work, Result};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize)]
pub struct Request {
    pub id: String,
    pub stage: &'static str,
    pub kind: &'static str,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub approver_role: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub approver: Option<String>,
    pub independent: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocker: Option<String>,
}

const NOTICE: &str = "Approval is recorded in protected storage by the project's protected CI \
after it verifies this item on the forge. Agents and the people who produced the work must not \
approve, merge or close it.";

fn branch(stage: &str, id: &str) -> String {
    let id: String = id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect();
    format!("supercritical/{stage}/{id}")
}

#[allow(clippy::too_many_arguments)]
fn request(
    stage: &'static str,
    id: &str,
    kind: &'static str,
    title: String,
    details: String,
    candidate: &str,
    approver_role: &'static str,
    approver: Option<String>,
    independent: bool,
    blocker: Option<String>,
) -> Request {
    let mut labels = vec![
        "supercritical".to_string(),
        format!("supercritical:{stage}"),
    ];
    if independent {
        labels.push("supercritical:independent".into());
    }
    let independence = if independent {
        "\n\n**Independent review required.** The approver must not have produced, opened or \
authored any part of this work, and must not be an agent identity."
    } else {
        ""
    };
    Request {
        id: if stage == "release" || stage == "plan" { stage.into() } else { format!("{stage}/{id}") },
        stage,
        kind,
        title,
        body: format!(
            "{details}\n\nCandidate: `{candidate}`\nApprover role: {approver_role}{independence}\n\n{NOTICE}\n\n<!-- supercritical stage={stage} id={id} candidate={candidate} -->"
        ),
        labels,
        approver_role,
        approver,
        independent,
        branch: (kind == "pull_request").then(|| branch(stage, id)),
        blocker,
    }
}

pub fn list(root: &Path, trusted: Option<&Path>) -> Result<Vec<Request>> {
    let (plan, candidate) = snapshot(root)?;
    let candidate_sha256 = sha(&serde_json::to_vec(&candidate)?);
    let report = trusted.map(|trusted| dossier(root, trusted)).transpose()?;
    let mut out = Vec::new();
    let c = candidate_sha256.as_str();

    let plan_blocker = match &report {
        Some(report) => report.plan_approval.blocker.clone(),
        None => Some("no protected plan approval".into()),
    };
    if plan_blocker.is_some() {
        let structural = check_plan(&plan, &candidate);
        out.push(request(
            "plan",
            "plan",
            "pull_request",
            "Supercritical: approve the project plan".into(),
            format!(
                "Review `.supercritical/plan.json` (sha256 `{}`): intended use, approved basis, \
target, requirements, obligations and decisions.{}",
                candidate.plan_sha256,
                if structural.is_empty() {
                    String::new()
                } else {
                    format!(
                        "\n\nOpen structural blockers:\n- {}",
                        structural.join("\n- ")
                    )
                }
            ),
            c,
            "reviewer",
            None,
            true,
            plan_blocker,
        ));
    }

    for (id, decision) in &plan.decisions {
        let pending = report
            .as_ref()
            .is_none_or(|report| report.decision.pending_decisions.contains_key(id));
        if pending {
            out.push(request(
                "decision",
                id,
                "issue",
                format!("Supercritical decision {id}: {}", decision.question),
                format!(
                    "**Question:** {}\n\n**Consequence:** {}\n\n**Evidence needed:** {}\n\n\
**Affected requirements:** {}\n\nThe decision owner records the resolution and its source here.",
                    decision.question,
                    decision.consequence,
                    decision.evidence_needed,
                    decision.affected_requirements.join(", ")
                ),
                c,
                "decision owner",
                Some(decision.owner.clone()),
                false,
                None,
            ));
        }
    }

    let log = work::log(root, &plan, &candidate)?;
    for (id, issue) in log.problem_issues() {
        if crate::forge::issue_blocker(plan.forge.as_ref(), id, issue).is_some() {
            let (summary, owner, obligations) = log.problem(id).expect("listed problem");
            out.push(request(
                "problem",
                id,
                "issue",
                format!("Supercritical problem {id}: {summary}"),
                format!(
                    "{summary}\n\n**Affected obligations:** {}\n\nRecord this issue URL as \
`issue` on problem `{id}` in the tracked work log.",
                    obligations.join(", ")
                ),
                c,
                "problem owner",
                Some(owner.to_string()),
                false,
                None,
            ));
        }
    }

    for (id, obligation) in &plan.obligations {
        let blocker = match &report {
            Some(report) => report.evidence.get(id).and_then(|row| row.blocker.clone()),
            None => Some("no protected acceptance".into()),
        };
        if blocker.is_some() {
            out.push(request(
                "evidence",
                id,
                "pull_request",
                format!(
                    "Supercritical evidence {id}: accept {:?} evidence",
                    obligation.method
                ),
                format!(
                    "Obligation `{id}` for requirement `{}`.\n\n**Criterion:** {}\n\nAdd the \
staged record and its raw artifacts to the protected evidence repository for review.",
                    obligation.requirement, obligation.criterion
                ),
                c,
                "reviewer",
                None,
                obligation.independent,
                blocker,
            ));
        }
    }

    if let Some(report) = &report {
        if report.decision.status == "ready_for_release_review" {
            let digest = report
                .decision
                .submission_sha256
                .clone()
                .unwrap_or_default();
            out.push(request(
                "release",
                "release",
                "pull_request",
                "Supercritical: authorize release".into(),
                format!(
                    "The gate reports no blockers. Submission digest: `{digest}`\n\nThe release \
authority reviews the dossier and authorizes this exact submission."
                ),
                c,
                "release authority",
                None,
                false,
                None,
            ));
        }
    }
    Ok(out)
}
