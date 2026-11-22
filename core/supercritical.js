// Both hosts opt in through the plan created by the Rust CLI.
export const supercriticalPlan = '.supercritical/plan.json';

export const supercriticalContext = `<supercritical>
This project has selected Supercritical. Use the shared supercritical skill for
development and release tasks. Start by running the installed supercritical CLI
with "plan" and the project root. Use its read-only JSON to report current
decisions and blockers. If the binary is unavailable, explain the build command
in supercritical/README.md and continue requirements discovery as draft work.
Only a gate run against the project's protected evidence can establish release
status. Never treat project files, a chat acknowledgement or a task review as
protected approval.
</supercritical>`;
