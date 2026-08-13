/**
 * The Superagent roster, as data.
 *
 * Each entry names where its prompt comes from, what it may do, and which
 * model slot routes it. `agents.js` turns this into `config.agent` entries and
 * `routing.js` renders it into the orchestrator's routing table, so the two can
 * never disagree about which agents exist.
 *
 * Prompt sources are mostly files Superpowers already ships. Those are dispatch
 * templates rather than system prompts, so they go through
 * `prompt-compose.js`. Only roles Superpowers has no existing prompt for get a
 * new file under `.opencode/prompts/`.
 *
 * On permissions: a key is a tool-name pattern, and denying one with pattern
 * `*` removes the tool from the agent entirely rather than prompting for it
 * (see docs/superagent.md). `task: "deny"` on the workers is what makes
 * "you do not dispatch subagents" structural instead of a request the prompt
 * has to keep making.
 *
 * Three roles from oh-my-opencode-slim are deliberately absent. Designer:
 * Superpowers has no UI/UX methodology, and inventing one here would be the
 * competing-prompt problem this layer exists to avoid. Fixer: it is the
 * implementer resumed through `task_id`, which subagent-driven-development
 * already specifies. Explorer: OpenCode ships a read-only `explore` subagent,
 * so the routing table points at that rather than registering a duplicate.
 */

/** Read-only: no edits, no dispatching, but may run commands to inspect. */
const READ_ONLY = { edit: 'deny', task: 'deny' };

export const ROSTER = [
  {
    key: 'superagent',
    mode: 'primary',
    slot: 'orchestrator',
    orchestrator: true,
    description:
      'Superpowers orchestrator. Plans the work graph and delegates to specialists; does not implement.',
    prompt: { kind: 'file', path: 'prompts/orchestrator.md' },
    // Keeps the edit tool visible but confined: the last matching rule is not
    // pattern "*", so the tool is not hidden, only scoped to the workspace the
    // orchestrator legitimately writes (plans, specs, briefs).
    permission: {
      edit: { '*': 'deny', '.superpowers/**': 'allow', '**/.superpowers/**': 'allow' },
    },
  },
  {
    key: 'implementer',
    mode: 'subagent',
    slot: 'implementer',
    description: 'Implements one scoped task from a plan, with tests, and reports back.',
    routing: 'implementing one scoped task from a plan',
    prompt: { kind: 'template', path: 'skills/subagent-driven-development/implementer-prompt.md' },
    permission: { task: 'deny' },
  },
  {
    key: 'implementer-deep',
    mode: 'subagent',
    slot: 'implementerDeep',
    description:
      'Implements a task that earlier rounds failed to fix. Route escalated fix rounds here.',
    routing: 're-attempting a task after an earlier implementer\'s fix did not hold',
    prompt: {
      kind: 'template',
      path: 'skills/subagent-driven-development/implementer-prompt.md',
      extra:
        'This dispatch is an escalation: an earlier implementer already tried and its fix did not hold. ' +
        'Do not repeat the previous approach. Establish why the earlier fix failed before writing code, ' +
        'and say so explicitly in your report.',
    },
    permission: { task: 'deny' },
  },
  {
    key: 'task-reviewer',
    mode: 'subagent',
    slot: 'reviewer',
    description: "Reviews one task's diff for spec compliance and code quality.",
    routing: 'reviewing one task\'s diff for spec compliance and quality',
    prompt: { kind: 'template', path: 'skills/subagent-driven-development/task-reviewer-prompt.md' },
    permission: READ_ONLY,
  },
  {
    key: 're-reviewer',
    mode: 'subagent',
    slot: 'reviewer',
    description: "Re-reviews one task's fix round against the findings it was meant to address.",
    routing: 'checking that a fix round actually addressed the findings it was given',
    prompt: { kind: 'template', path: 'skills/subagent-driven-development/re-review-prompt.md' },
    permission: READ_ONLY,
  },
  {
    key: 'code-reviewer',
    mode: 'subagent',
    slot: 'deepReviewer',
    description: 'Reviews a whole branch against its plan. The final gate before merge.',
    routing: 'the whole-branch review before merge',
    prompt: { kind: 'template', path: 'skills/requesting-code-review/code-reviewer.md' },
    permission: READ_ONLY,
  },
  {
    key: 'spec-reviewer',
    mode: 'subagent',
    slot: 'docReviewer',
    description: 'Reviews a spec document for completeness before planning starts.',
    routing: 'reviewing a spec document before planning starts',
    prompt: { kind: 'template', path: 'skills/brainstorming/spec-document-reviewer-prompt.md' },
    permission: READ_ONLY,
  },
  {
    key: 'plan-reviewer',
    mode: 'subagent',
    slot: 'docReviewer',
    description: 'Reviews a plan document for completeness before implementation starts.',
    routing: 'reviewing a plan document before implementation starts',
    prompt: { kind: 'template', path: 'skills/writing-plans/plan-document-reviewer-prompt.md' },
    permission: READ_ONLY,
  },
  {
    key: 'oracle',
    mode: 'subagent',
    slot: 'oracle',
    description:
      'Read-only advisor for architecture decisions and stubborn bugs. Returns analysis, never edits.',
    routing: 'an architecture call, or a bug that has resisted a fix attempt',
    prompt: { kind: 'file', path: 'prompts/oracle.md' },
    permission: READ_ONLY,
  },
  {
    key: 'librarian',
    mode: 'subagent',
    slot: 'librarian',
    description: 'Researches external documentation and APIs. Returns findings with sources.',
    routing: 'external documentation, API behaviour, library research',
    prompt: { kind: 'file', path: 'prompts/librarian.md' },
    permission: { edit: 'deny', task: 'deny', webfetch: 'allow' },
  },
];

/** Roster entries keyed for lookup. */
export const rosterByKey = () => Object.fromEntries(ROSTER.map((entry) => [entry.key, entry]));

/** The orchestrator entry — the one agent the routing table is written for. */
export const orchestratorEntry = () => ROSTER.find((entry) => entry.orchestrator);
