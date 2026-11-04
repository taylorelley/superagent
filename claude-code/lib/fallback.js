/**
 * Working beside a plugin that passes Superagent's prompt hooks by.
 *
 * Claude Code lets a plugin that runs before Superagent send an event on past
 * the plugins beneath it. The built-in security default
 * (`cc-plugin-sec-default@builtin`) does this for `prompt.compose` and
 * `prompt.context` in Team and Enterprise organisations and on machines with
 * managed settings: plugins a person installs may not change the system prompt
 * or the conversation's opening context. That is a policy, so Superagent does
 * not route the same text through another event. It notices the hooks did not
 * run, stops doing what only made sense alongside them, and says so.
 *
 * The mods API reports no skip to the plugin skipped, so this is judged by
 * observation: both hooks run before the main thread's first model request,
 * so if that request arrives and a hook has not run, it was passed by. The
 * verdict is taken only on a fresh session's first request; after a reload
 * or resume the hooks may not run again, and that is not a skip.
 *
 * Pure; the hooks module records what ran and acts on the verdict.
 */

/**
 * Whether this model request is one the verdict may be taken on: the main
 * thread's first request of the session's first prompt (`turns`, from
 * `$.session.turns()`). The request's own `messageCount` is no guide: the
 * engine's reminders and attachments make it well over one from the start.
 */
export const isFirstRequest = (step, turns) =>
  !step?.agentId && step?.index === 0 && typeof turns === 'number' && turns <= 1;

/**
 * What was passed by, given which hooks ran and what Superagent wanted from
 * them. `role`: the orchestrator's system prompt section was wanted and
 * `prompt.compose` never ran. `bootstrap`: the opening context was wanted and
 * `prompt.context` never ran.
 */
export const judgeHostHooks = ({ seen, wantRole, wantBootstrap }) => ({
  role: Boolean(wantRole) && !seen?.compose,
  bootstrap: Boolean(wantBootstrap) && !seen?.context,
});

const missingParts = (verdict) =>
  [verdict.role ? 'the orchestrator role' : '', verdict.bootstrap ? 'the session bootstrap' : '']
    .filter(Boolean)
    .join(' and ');

export const isBlocked = (verdict) => Boolean(verdict?.role || verdict?.bootstrap);

/** The transcript line, once per session. Addressed to the person. */
export const fallbackNotice = (verdict, { pluginName = 'superagent' } = {}) => {
  if (!isBlocked(verdict)) return null;
  const lines = [
    `Another plugin that runs before Superagent kept it from adding ${missingParts(verdict)}.`,
    "This is usually Claude Code's built-in security default for Team and Enterprise organisations, which stops plugins you install from changing the system prompt.",
    'The specialist agents, skills, job board and commands still work.',
  ];
  if (verdict.role) {
    lines.push(
      'The main conversation runs as plain Claude Code: no orchestrator model routing and no write guard.',
    );
  }
  if (verdict.bootstrap) {
    lines.push(`To load Superagent's guidance yourself, run /${pluginName}:using-superagent.`);
  }
  lines.push(
    'Only your organisation can change this, through managed settings. See "When another plugin runs first" in docs/claude-code.md.',
  );
  return lines.join(' ');
};

/**
 * One short line for the panel and `/preset`; fits the 35-column sidebar.
 * The bootstrap is part of the orchestrator's set-up, so losing the role
 * reads as the orchestrator being off; the transcript notice has the detail.
 */
export const fallbackLine = (verdict) => {
  if (!isBlocked(verdict)) return null;
  return `⚠ ${verdict.role ? 'orchestrator' : 'bootstrap'} off: org policy`;
};
