use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub version: u32,
    pub intended_use: String,
    pub approval_basis: String,
    pub target: String,
    pub files: Vec<String>,
    pub requirements: BTreeMap<String, Requirement>,
    pub obligations: BTreeMap<String, Obligation>,
    pub decisions: BTreeMap<String, Decision>,
    #[serde(default)]
    pub rust_checks: BTreeMap<String, RustCheck>,
    #[serde(default)]
    pub objectives: BTreeMap<String, Objective>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Objective {
    pub description: String,
    pub obligations: Vec<String>,
}

#[derive(Serialize)]
pub struct ObjectiveReview {
    pub blockers: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum RustCheck {
    Kani { property: String },
    Libtest { test: String },
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Requirement {
    pub source: String,
    pub behavior: String,
    pub implementation: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Obligation {
    pub requirement: String,
    pub method: Method,
    pub criterion: String,
    pub independent: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Method {
    Review,
    Test,
    Proof,
    TargetValidation,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Decision {
    pub question: String,
    pub consequence: String,
    pub evidence_needed: String,
    pub owner: String,
    pub affected_requirements: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Trust {
    pub version: u32,
    pub approved_plan: String,
    pub producers: BTreeMap<String, Vec<Method>>,
    pub reviewers: Vec<String>,
    pub decision_owners: Vec<String>,
    pub release_authorities: Vec<String>,
    pub decisions: BTreeMap<String, Resolution>,
    pub acceptances: BTreeMap<String, Acceptance>,
    pub release: Option<Authorization>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Resolution {
    pub owner: String,
    pub resolution: String,
    pub source: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Acceptance {
    pub reviewer: String,
    pub record_sha256: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Authorization {
    pub authority: String,
    pub submission_sha256: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Evidence {
    pub obligation: String,
    pub candidate_sha256: String,
    pub method: Method,
    pub producer: String,
    pub authors: Vec<String>,
    pub outcome: Outcome,
    pub raw_path: String,
    pub raw_sha256: String,
    pub observed: String,
    pub limitations: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub artifacts: BTreeMap<String, String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Pass,
    Fail,
    Incomplete,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Candidate {
    pub plan_sha256: String,
    pub files: BTreeMap<String, String>,
}

#[derive(Serialize)]
pub struct Gate {
    pub candidate_sha256: String,
    pub submission_sha256: Option<String>,
    pub status: &'static str,
    pub blockers: Vec<String>,
    pub pending_decisions: BTreeMap<String, Decision>,
}

#[derive(Serialize)]
pub struct EvidenceReview {
    pub acceptance: Option<Acceptance>,
    pub result: Option<Evidence>,
    pub blocker: Option<String>,
}

#[derive(Serialize)]
pub struct Dossier {
    pub decision: Gate,
    pub candidate: Candidate,
    pub plan: Plan,
    pub evidence: BTreeMap<String, EvidenceReview>,
    pub trace: BTreeMap<String, Vec<String>>,
    pub objectives: BTreeMap<String, ObjectiveReview>,
    pub resolved_decisions: BTreeMap<String, Resolution>,
    pub release_authorization: Option<Authorization>,
}
