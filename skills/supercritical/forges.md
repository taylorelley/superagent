# Raising Supercritical requests on a forge

Reference for the `supercritical` skill. Raise each item from
`supercritical requests` with the project's own forge. Never approve, merge or
close an item.

## Detect the forge

Read the remote and match its host. Then check for the CLI.

```bash
git remote get-url origin
command -v gh glab az tea 2>/dev/null
```

| Remote host | `forge.system` | CLI |
| --- | --- | --- |
| `github.com` or GitHub Enterprise | `github` | `gh` |
| `gitlab.com` or self-managed GitLab | `gitlab` | `glab` |
| `dev.azure.com`, `*.visualstudio.com` | `azure_devops` | `az` with the `azure-devops` extension |
| Gitea or Forgejo host (`tea login list` shows it) | `gitea` | `tea` |
| No forge; the project uses a CM system | `manual` | none |

The `forge.system` in the plan wins over detection. If they disagree, stop and
ask.

## Raise each item

`kind: "issue"` items become issues, or work items on Azure Boards.
`kind: "pull_request"` items become a pull or merge request from the item's
`branch`. Commit the change the item covers to that branch first: the plan for
`plan`, the staged record and raw artifacts (in the protected evidence
repository) for `evidence`, and the release request for `release`.

| Action | GitHub | GitLab | Azure DevOps | Gitea/Forgejo |
| --- | --- | --- | --- | --- |
| Issue | `gh issue create --title T --body-file B --label L --assignee A` | `glab issue create --title T --description "$(cat B)" --label L --assignee A` | `az boards work-item create --type Issue --title T --description "$(cat B)" --assigned-to A` | `tea issues create --title T --description "$(cat B)" --labels L` |
| Pull request | `gh pr create --head BR --title T --body-file B --label L --reviewer R` | `glab mr create --source-branch BR --title T --description "$(cat B)" --label L --reviewer R` | `az repos pr create --source-branch BR --title T --description "$(cat B)" --reviewers R` | `tea pr create --head BR --title T --description "$(cat B)" --labels L` |

Write the item's `body` to a temporary file and pass it as `B`, so the CLI
quotes it correctly. Create the labels first if the forge rejects unknown
labels. When `approver` is empty, request the team or group that holds
`approver_role`, as the project's CODEOWNERS or approval rules name it.

**No CLI:** give the person the forge's new issue or pull request URL with the
title, body and labels to paste, then stop.

**`manual`:** write the body to `.supercritical/requests/<stage>-<id>.md` for
the project's configuration management process, hand it to the person, and
stop. Protected records then cite the CM record ID under the declared prefix.

## Forge-side protection

The gate trusts only what protected CI writes, and protected CI should trust
only a protected branch. Recommend these settings to the project's CM owner.
Do not change them yourself.

| Forge | Settings |
| --- | --- |
| GitHub | Branch protection or rulesets on the plan and protected evidence branches; CODEOWNERS for `.supercritical/` and evidence paths; require approval of the most recent reviewable push; dismiss stale approvals; for independent items, a CODEOWNERS team made of independent reviewers |
| GitLab | Protected branches; approval rules per group; prevent approval by the author; prevent approvals by users who add commits; remove all approvals when commits are added |
| Azure DevOps | Branch policies with required reviewers per path; turn off "allow requestors to approve their own changes"; reset votes when new changes are pushed |
| Gitea/Forgejo | Branch protection with required approvals from a protected team; block merge on rejected reviews; dismiss stale approvals |
| Manual | The CM record names the approver and states that they had no part in producing an independent item |
