//! Forge references for protected sign-offs.
//!
//! Every human sign-off in `trust.json` cites the issue, pull request, merge
//! request or configuration management record where it was made. The CLI does
//! not contact the forge: a protected CI job verifies the approval there and
//! writes the reference. These checks confirm that each reference is complete,
//! belongs to the project's declared forge, names the role-holder who signed
//! off, and, for independent review, that the approver had no part in the work.

use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum System {
    Github,
    Gitlab,
    AzureDevops,
    Gitea,
    Manual,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Issue,
    PullRequest,
    /// A configuration management record, for projects without a forge.
    Record,
}

/// The project's forge, declared in the plan.
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub system: System,
    /// Every reference must start with this prefix, for example
    /// `https://github.com/org/repo/`. For `manual`, a CM record namespace.
    pub url_prefix: String,
    /// Agent and automation identities. None of them may hold a sign-off.
    #[serde(default)]
    pub agent_identities: BTreeSet<String>,
}

/// Where and by whom a sign-off was made, as verified by protected CI.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Ref {
    pub system: System,
    pub kind: Kind,
    pub url: String,
    pub id: String,
    pub opened_by: String,
    /// Commit authors and co-authors of a pull request, as the forge reports.
    #[serde(default)]
    pub authors: BTreeSet<String>,
    pub approver: String,
    pub approved_at: String,
    /// The head commit that was merged.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// The head commit the approver approved.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approved_revision: Option<String>,
}

/// What a sign-off stage accepts.
pub struct Stage<'a> {
    pub name: &'a str,
    pub kinds: &'a [Kind],
    /// The role-holder who must be the approver.
    pub approver: &'a str,
    /// Identities that must not approve, when review is independent.
    pub independent_of: Option<BTreeSet<&'a str>>,
}

pub const CHANGE: &[Kind] = &[Kind::PullRequest, Kind::Record];
pub const DECISION: &[Kind] = &[Kind::Issue, Kind::PullRequest, Kind::Record];

fn is_revision(value: &Option<String>) -> bool {
    value.as_ref().is_some_and(|value| {
        matches!(value.len(), 40 | 64)
            && value
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    })
}

/// Problems with the plan's forge declaration, for `check_plan`.
pub fn config_blocker(config: Option<&Config>) -> Option<String> {
    let Some(config) = config else {
        return Some(
            "Declare the project's forge or configuration management system under forge".into(),
        );
    };
    let prefix = config.url_prefix.trim();
    if prefix.is_empty()
        || (config.system != System::Manual
            && (!prefix.starts_with("https://") || !prefix.ends_with('/')))
    {
        return Some(
            "forge: give the https repository URL prefix, ending in /, or a CM record prefix"
                .into(),
        );
    }
    if config
        .agent_identities
        .iter()
        .any(|id| id.trim().is_empty())
    {
        return Some("forge: agent identities must not be blank".into());
    }
    None
}

/// A problem report's tracked issue.
pub fn issue_blocker(config: Option<&Config>, id: &str, issue: Option<&str>) -> Option<String> {
    let config = config?;
    match issue {
        Some(url) if url.len() > config.url_prefix.len() && url.starts_with(&config.url_prefix) => {
            None
        }
        _ => Some(format!("{id}: raise a tracked issue for this problem")),
    }
}

/// Check one sign-off reference. Errors read as gate blockers.
pub fn check(
    reference: Option<&Ref>,
    stage: &Stage,
    config: Option<&Config>,
) -> Result<(), String> {
    let name = stage.name;
    let config = config.ok_or_else(|| format!("{name}: the plan declares no forge"))?;
    let reference = reference.ok_or_else(|| format!("{name}: cite the approved forge item"))?;
    if reference.system != config.system {
        return Err(format!(
            "{name}: the sign-off was made outside the project's forge"
        ));
    }
    if reference.url.len() <= config.url_prefix.len()
        || !reference.url.starts_with(&config.url_prefix)
    {
        return Err(format!(
            "{name}: the forge item is outside the project repository"
        ));
    }
    if (reference.kind == Kind::Record) != (config.system == System::Manual)
        || !stage.kinds.contains(&reference.kind)
    {
        return Err(format!(
            "{name}: this sign-off needs an approved {}",
            if config.system == System::Manual {
                "configuration management record"
            } else if stage.kinds.contains(&Kind::Issue) {
                "issue or pull request"
            } else {
                "pull request"
            }
        ));
    }
    if [
        &reference.id,
        &reference.opened_by,
        &reference.approver,
        &reference.approved_at,
    ]
    .iter()
    .any(|value| value.trim().is_empty())
        || reference
            .authors
            .iter()
            .any(|value| value.trim().is_empty())
    {
        return Err(format!(
            "{name}: record the forge item ID, opener, approver and approval time"
        ));
    }
    if reference.approver != stage.approver {
        return Err(format!(
            "{name}: the forge approver is not the recorded role-holder"
        ));
    }
    if config.agent_identities.contains(&reference.approver) {
        return Err(format!("{name}: an agent identity cannot sign off"));
    }
    if reference.kind == Kind::PullRequest {
        if !is_revision(&reference.revision) || !is_revision(&reference.approved_revision) {
            return Err(format!(
                "{name}: record the merged and approved commit revisions"
            ));
        }
        if reference.revision != reference.approved_revision {
            return Err(format!("{name}: the approval predates the merged revision"));
        }
    }
    if let Some(excluded) = &stage.independent_of {
        let approver = reference.approver.as_str();
        if excluded.contains(approver)
            || reference.opened_by == approver
            || reference.authors.contains(approver)
        {
            return Err(format!(
                "{name}: independent review requires an approver who did not produce, open or author the work"
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(system: System, prefix: &str) -> Config {
        Config {
            system,
            url_prefix: prefix.into(),
            agent_identities: BTreeSet::new(),
        }
    }

    #[test]
    fn forge_prefix_must_be_an_https_directory() {
        assert!(config_blocker(None).is_some());
        assert!(
            config_blocker(Some(&config(System::Github, "https://example/org/repo"))).is_some()
        );
        assert!(
            config_blocker(Some(&config(System::Gitlab, "http://example/org/repo/"))).is_some()
        );
        assert!(config_blocker(Some(&config(
            System::AzureDevops,
            "https://example/org/repo/"
        )))
        .is_none());
        assert!(config_blocker(Some(&config(System::Manual, "CM-"))).is_none());
    }

    #[test]
    fn manual_projects_cite_records_and_forges_do_not() {
        let manual = config(System::Manual, "CM-");
        let reference = Ref {
            system: System::Manual,
            kind: Kind::Record,
            url: "CM-42".into(),
            id: "42".into(),
            opened_by: "author".into(),
            authors: BTreeSet::new(),
            approver: "reviewer".into(),
            approved_at: "2026-11-23".into(),
            revision: None,
            approved_revision: None,
        };
        let stage = Stage {
            name: "release",
            kinds: CHANGE,
            approver: "reviewer",
            independent_of: Some(BTreeSet::from(["producer"])),
        };
        assert_eq!(check(Some(&reference), &stage, Some(&manual)), Ok(()));
        let forge = config(System::Gitea, "https://example/org/repo/");
        let forged = Ref {
            system: System::Gitea,
            url: "https://example/org/repo/pulls/1".into(),
            ..reference
        };
        assert!(check(Some(&forged), &stage, Some(&forge)).is_err());
    }

    #[test]
    fn problem_issue_must_be_inside_the_repository() {
        let forge = config(System::Github, "https://example/org/repo/");
        assert!(issue_blocker(None, "P", None).is_none());
        assert!(issue_blocker(Some(&forge), "P", None).is_some());
        assert!(issue_blocker(Some(&forge), "P", Some("https://example/org/repo/")).is_some());
        assert!(
            issue_blocker(Some(&forge), "P", Some("https://example/org/repo/issues/3")).is_none()
        );
    }
}
