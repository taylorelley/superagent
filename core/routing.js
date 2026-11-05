/**
 * The routing table: the one thing the orchestrator cannot learn from a skill.
 *
 * `subagent-driven-development` tells a controller to choose a *model* for each
 * dispatch. OpenCode V2's `subagent` tool does take a `model`, but its own
 * description tells the model never to set it unless the user asks, and a
 * guessed model ID fails the dispatch; Claude Code's `Agent` tool takes only a
 * family alias. So the choice Superagent offers is
 * which *agent* to dispatch — each one already routed to its slot's model. This module renders that translation from the live roster, so
 * the table can never name an agent that was not registered.
 *
 * It is rendered fresh from whatever `agents.js` actually registered, including
 * the configured prefix and minus anything disabled or skipped for a name
 * collision.
 */

/**
 * What differs between hosts: how a dispatch names its agent, the built-in
 * subagents worth preferring over a specialist, and how background dispatch
 * and follow-ups are spelled.
 */
export const DISPATCH = {
  codex: {
    field: '`agent_type`',
    tool: '`spawn_agent`',
    builtins: [
      { name: 'explorer', use: 'read-only codebase reconnaissance' },
      { name: 'default', use: 'a task outside the specialist roster' },
    ],
    background: [
      'Dispatch independent tasks with `spawn_agent` before waiting.',
      'Use fresh context (`fork_context: false` where offered).',
      'Continue a child with `send_input`; await results with `wait_agent`.',
      'Use the actual tool inventory if your Codex version names these differently.',
    ],
  },
  opencode: {
    field: '`agent`',
    tool: '`subagent`',
    builtins: [
      {
        name: 'explore',
        use: 'read-only codebase reconnaissance — where does X live, what calls Y',
      },
      { name: 'general', use: 'a multi-step job that fits none of the specialists above' },
    ],
    // Background dispatch is native to OpenCode V2's `subagent` tool; V1 gated
    // it behind OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS.
    background: [
      '**Background dispatch is available.** Independent work should use',
      '`background: true` and keep going; you are notified on completion. Do not',
      'poll, sleep, or ask a running subagent for status. Dependent work waits for',
      'the real result — a subagent that stopped without reporting is not one that',
      'succeeded. To send a running or finished subagent follow-up instructions,',
      'call `subagent` again with the `sessionID` it returned.',
    ],
  },
  claude: {
    field: '`subagent_type`',
    tool: '`Agent`',
    builtins: [
      {
        name: 'Explore',
        use: 'read-only codebase reconnaissance — where does X live, what calls Y',
      },
      {
        name: 'general-purpose',
        use: 'a multi-step job that fits none of the specialists above',
      },
    ],
    // Interactive Claude Code runs every dispatch in the background and has no
    // `run_in_background` parameter; `claude -p` and the SDK offer one.
    background: [
      '**Background dispatch is available.** Independent work should run in the',
      'background — set `run_in_background: true` where the `Agent` tool takes it;',
      'where it does not, every dispatch already runs in the background — and keep',
      'going; you are notified on completion. Do not poll, sleep, or ask a running',
      'subagent for status. Dependent work waits for the real result — a subagent',
      'that stopped without reporting is not one that succeeded. To send a running',
      'or finished subagent follow-up instructions, use `SendMessage` addressed to',
      'the agent id it returned.',
    ],
  },
};

const dispatchFor = (host) => DISPATCH[host] ?? DISPATCH.opencode;

export const renderRoutingTable = (registered, { host = 'opencode' } = {}) => {
  const workers = registered.filter((entry) => entry.mode !== 'primary');
  const d = dispatchFor(host);

  const lines = [
    '<SUPERAGENT_ROUTING>',
    'This session has a Superagent specialist roster. Route work to it.',
    '',
    '**Model selection is agent selection.** Where `subagent-driven-development`',
    'tells you to pick a model per dispatch, pick the agent instead — each one',
    `below is already routed to the model its job deserves. Leave the ${d.tool}`,
    "tool's own `model` unset unless your human partner names a model.",
    '',
    `| Dispatch ${d.field} | Use it for |`,
    '|---|---|',
    // `routing` is per agent, not per model slot: two agents can share a slot
    // (task-reviewer and re-reviewer both route to `reviewer`) and the
    // orchestrator still has to be able to tell them apart.
    ...workers.map((entry) => `| \`${entry.name}\` | ${entry.routing ?? entry.description} |`),
    ...d.builtins.map((b) => `| \`${b.name}\` | ${b.use} |`),
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
    '',
    ...d.background,
  ];

  lines.push('</SUPERAGENT_ROUTING>');
  return lines.join('\n');
};

/**
 * Render the conflicts collected by `registerAgents` / `registerCouncillors` /
 * `registerCommands` into a block for the session bootstrap.
 *
 * A collision is already handled safely at registration time — the user's
 * definition wins and Superagent's entry is skipped. This block exists only
 * to make that visible somewhere other than a stderr log line, by putting it
 * in the model's context so it can be relayed to the human once.
 */
export const renderConflicts = (conflicts, { host = 'opencode' } = {}) => {
  if (!conflicts?.length) return '';

  const label = (c) => (c.kind === 'command' ? `command \`/${c.name}\`` : `agent \`${c.name}\``);
  const where =
    host === 'codex' ? 'Codex setup' : host === 'claude' ? 'Claude Code setup' : 'OpenCode config';
  const agentClash = conflicts.some((c) => c.kind !== 'command');

  return [
    '<SUPERAGENT_CONFIG_CONFLICTS>',
    `**Name conflicts on install.** These already existed in your ${where}`,
    'and were left alone — yours wins:',
    '',
    ...conflicts.map((c) => `- ${label(c)}`),
    '',
    ...(agentClash
      ? [
          'Set `{"agents": {"prefix": "sp-"}}` in superagent.json to register the full',
          'Superagent roster alongside your own names instead of skipping them.',
        ]
      : ['Superagent did not register its own command under that name.']),
    'Mention this to your human partner once, near the start of the session,',
    "then don't repeat it.",
    '</SUPERAGENT_CONFIG_CONFLICTS>',
  ].join('\n');
};
