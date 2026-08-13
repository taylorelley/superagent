/**
 * The routing table: the one thing the orchestrator cannot learn from a skill.
 *
 * `subagent-driven-development` tells a controller to choose a *model* for each
 * dispatch. OpenCode's `task` tool has no model parameter, so that instruction
 * cannot be followed literally here — the choice that exists is which *agent*
 * to dispatch. This module renders that translation from the live roster, so
 * the table can never name an agent that was not registered.
 *
 * It is rendered fresh from whatever `agents.js` actually registered, including
 * the configured prefix and minus anything disabled or skipped for a name
 * collision.
 */

/** Built-in OpenCode subagents the orchestrator should prefer over new ones. */
const BUILTINS = [
  { name: 'explore', use: 'read-only codebase reconnaissance — where does X live, what calls Y' },
  { name: 'general', use: 'a multi-step job that fits none of the specialists above' },
];

export const renderRoutingTable = (registered, { backgroundAvailable } = {}) => {
  const workers = registered.filter((entry) => entry.mode !== 'primary');

  const lines = [
    '<SUPERAGENT_ROUTING>',
    'This session has a Superagent specialist roster. Route work to it.',
    '',
    '**Model selection is agent selection.** OpenCode\'s `task` tool takes no',
    '`model` parameter, so where `subagent-driven-development` tells you to pick a',
    'model per dispatch, pick the agent instead — each one below is already routed',
    'to the model its job deserves.',
    '',
    '| Dispatch `subagent_type` | Use it for |',
    '|---|---|',
    // `routing` is per agent, not per model slot: two agents can share a slot
    // (task-reviewer and re-reviewer both route to `reviewer`) and the
    // orchestrator still has to be able to tell them apart.
    ...workers.map((entry) => `| \`${entry.name}\` | ${entry.routing ?? entry.description} |`),
    ...BUILTINS.map((b) => `| \`${b.name}\` | ${b.use} |`),
    '',
    '**Every delegated prompt must stand alone.** The subagent inherits none of',
    'your context. Include: the objective, the files in scope, which files it may',
    'write, the output you expect, whether edits are permitted, how to validate,',
    'and what not to do. A specialist handed work outside its role replies with a',
    'rejection reason — reroute it, never re-send it unchanged.',
    '',
    '**One writer per file.** Before dispatching anything that writes, state the',
    'ownership boundary in the prompt on its own line:',
    '',
    '    <!-- superagent-ownership: write=src/api/**; read=src/** -->',
    '',
    'Never let two concurrent write-capable dispatches claim the same path.',
  ];

  if (backgroundAvailable) {
    lines.push(
      '',
      '**Background dispatch is available.** Independent work should use',
      '`background: true` and keep going; you are notified on completion. Do not',
      'poll, sleep, or ask a running task for status. Dependent work waits for the',
      'real result — a task that stopped without reporting is not a task that',
      'succeeded.'
    );
  } else {
    lines.push(
      '',
      '**Background dispatch is unavailable** in this session (it needs',
      '`OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true`). Dispatch independent work',
      'as several `task` calls in one message, and sequence dependent work. The',
      'one-writer-per-file rule still applies.'
    );
  }

  lines.push('</SUPERAGENT_ROUTING>');
  return lines.join('\n');
};
