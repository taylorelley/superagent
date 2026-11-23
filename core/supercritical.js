// Both hosts opt in through the plan created by the Rust CLI.
import { toRules } from './permissions.js';

export const supercriticalPlan = '.supercritical/plan.json';

export const supercriticalContext = `<supercritical>
This project has selected Supercritical. Use the shared supercritical skill for
development and release tasks. Start by running the installed supercritical CLI
with "plan" and the project root. Use its read-only JSON to report current
decisions and blockers. If the binary is unavailable, explain the build command
in supercritical/README.md and continue requirements discovery as draft work.
Only a gate run against the project's protected evidence can establish release
status. Never treat project files, a chat acknowledgement or a task review as
protected approval. Raise every review and approval as an issue or pull request
from "supercritical requests", then stop and report the link. Never approve,
merge or close those items yourself, and never write trust.json or staged
records.
</supercritical>`;

// Shell commands that approve, merge, vote on or close forge items, matched
// anywhere in a command line so a compound command cannot slip one through.
const SIGNOFF_COMMANDS = [
  // GitHub
  'gh pr merge',
  'gh pr review',
  'gh issue close',
  'gh api*/merge',
  'gh api*/reviews',
  // GitLab
  'glab mr approve',
  'glab mr merge',
  'glab issue close',
  'glab api*/approve',
  'glab api*/merge',
  // Azure DevOps
  'az repos pr update',
  'az repos pr set-vote',
  'az repos pr reviewer',
  'az boards work-item update',
  // Gitea and Forgejo
  'tea pr merge',
  'tea pr approve',
  'tea pr reject',
  'tea pulls merge',
  'tea pulls approve',
  'tea issues close',
];

// Protected sign-off files and staged evidence, in any form a path may take.
const PROTECTED_FILES = [
  'trust.json',
  '*/trust.json',
  '.supercritical/records/*',
  '*/.supercritical/records/*',
];

/**
 * Denials both hosts add for every agent while a project uses Supercritical:
 * agents raise reviews and approvals, people make them. Shell patterns cannot
 * catch every route to a forge, so these stop accidental self-approval; the
 * forge's branch protection and the gate are the enforcement.
 */
export const supercriticalPermissions = {
  shell: Object.fromEntries(SIGNOFF_COMMANDS.map((command) => [`*${command}*`, 'deny'])),
  edit: Object.fromEntries(PROTECTED_FILES.map((file) => [file, 'deny'])),
};

export const supercriticalRules = toRules(supercriticalPermissions);

export const supercriticalRefusal =
  'Supercritical: agents raise reviews and approvals as issues or pull requests; ' +
  'the authorised people approve, merge and close them on the forge, and protected CI ' +
  'records the sign-off. Report the item link and stop.';
