/**
 * Superagent's slash commands, by name, and which of them a session gets.
 * Shared by both hosts; each host registers and answers them its own way.
 */

export const COMMANDS = {
  council: {
    description: 'Ask several models the same question and synthesize the answers',
  },
  preset: {
    description: 'Show or switch the Superagent preset',
  },
  board: {
    description: 'Show the Superagent job board for this session',
  },
  update: {
    description: 'Check for, or install, a Superagent update',
  },
};

/**
 * Whether a command is worth offering, given the resolved settings.
 *
 * `/council` and `/board` expand to "not configured" text when their feature is
 * off, so registering them under the `solo` preset offers the user a command
 * that cannot do anything. `/preset` stays useful in every state — it is how
 * you turn the layer back on.
 */
const COMMAND_ENABLED = {
  council: (settings) => settings?.council?.enabled !== false,
  board: (settings) => settings?.board?.enabled !== false,
  preset: () => true,
  update: () => true,
};

/**
 * Which commands to register.
 *
 * `existing` is the set of command names the host already has. OpenCode's V2
 * command editor can only add, and a later registration would shadow the
 * user's own command of the same name; Claude Code's registered commands are
 * unprefixed slash commands too. So collisions are filtered here, before
 * registering, and the user's command wins.
 *
 * Returns `{ commands, conflicts }`; `commands` is `[{ name, description }]`.
 */
export const commandsToRegister = (settings, existing = new Set()) => {
  const commands = [];
  const conflicts = [];
  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (!COMMAND_ENABLED[name](settings)) continue;
    if (existing.has(name)) {
      conflicts.push({ kind: 'command', name });
      continue;
    }
    commands.push({ name, ...spec });
  }
  return { commands, conflicts };
};
