/**
 * Slash commands.
 *
 * Registered by mutating `config.command`, then intercepted in
 * `command.execute.before` where the arguments are known and the expansion can
 * depend on live state. A command whose expansion is static is just a template
 * and needs no interception.
 */

import fs from 'fs';
import { councilInstruction } from './council.js';
import { stateFilePath } from './config-schema.js';
import { SHIPPED_PRESETS } from './presets.js';
import { renderBoard } from './board.js';
import { warn } from './log.js';

export const COMMANDS = {
  council: {
    description: 'Ask several models the same question and synthesize the answers',
    template: 'Convene the council.',
  },
  preset: {
    description: 'Show or switch the Superagent preset',
    template: 'Show the Superagent preset.',
  },
  board: {
    description: 'Show the Superagent job board for this session',
    template: 'Show the job board.',
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
};

export const registerCommands = (config, settings) => {
  config.command = config.command || {};
  for (const [name, spec] of Object.entries(COMMANDS)) {
    if (!COMMAND_ENABLED[name](settings)) continue;
    if (Object.prototype.hasOwnProperty.call(config.command, name)) {
      warn(`a command named "/${name}" already exists; leaving it alone`);
      continue;
    }
    config.command[name] = { ...spec };
  }
};

/**
 * Explain what a preset switch can and cannot do.
 *
 * Being straight about this matters. Agents are resolved into cached state at
 * startup, so switching a preset that routes a model slot differently does
 * nothing until OpenCode restarts. Reporting "switched" without saying so would
 * leave the user believing they are on a model they are not on.
 */
const presetReport = (settings, args, configDir) => {
  const known = { ...SHIPPED_PRESETS, ...(settings.presets ?? {}) };
  const [name, ...flags] = args.trim().split(/\s+/).filter(Boolean);

  if (!name || name === 'show') {
    return [
      `Active preset: **${settings.preset}**`,
      `Agents: ${settings.agents.enabled ? 'on' : 'off'} · Board: ${settings.board.enabled ? 'on' : 'off'} · Council: ${settings.council.enabled ? 'on' : 'off'}`,
      '',
      `Available: ${Object.keys(known).sort().join(', ')}`,
      '',
      'Tell your human partner this and stop. Do not take any other action.',
    ].join('\n');
  }

  if (name === 'list') {
    return [
      'Superagent presets:',
      ...Object.keys(known)
        .sort()
        .map((key) => `  - ${key}${key === settings.preset ? '  (active)' : ''}`),
      '',
      'Tell your human partner this and stop. Do not take any other action.',
    ].join('\n');
  }

  if (!known[name]) {
    return `There is no preset named "${name}". Available: ${Object.keys(known).sort().join(', ')}. Tell your human partner and stop.`;
  }

  const persist = flags.includes('--persist');
  let persisted = false;
  if (persist && configDir) {
    try {
      // On a first run the config directory may not exist yet, and without this
      // the write fails, the catch swallows it, and the reply tells the user to
      // re-run the command that just failed.
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(stateFilePath(configDir), `${JSON.stringify({ preset: name }, null, 2)}\n`);
      persisted = true;
    } catch (err) {
      warn(`could not persist preset: ${err.message}`);
    }
  }

  return [
    `Preset "${name}" ${persisted ? 'saved' : 'selected'}.`,
    '',
    '**This does not take effect until OpenCode restarts.** Agent definitions —',
    'which agents exist, and which model each one is routed to — are resolved',
    'once at startup and cached. Nothing about the running session changes.',
    persisted
      ? 'The choice is saved, so it will apply next time you start OpenCode.'
      : `Re-run as \`/preset ${name} --persist\` to save the choice, or set "preset": "${name}" in superagent.json.`,
    '',
    'Tell your human partner exactly this and stop. Do not take any other action.',
  ].join('\n');
};

/**
 * Rewrite a command into its real instruction.
 *
 * Returns the replacement text, or null to leave the command alone.
 */
export const expandCommand = (command, args, { settings, councillors, configDir, sessionID }) => {
  if (command === 'council') {
    return councilInstruction(councillors ?? [], (args ?? '').trim());
  }

  if (command === 'preset') {
    return presetReport(settings, args ?? '', configDir);
  }

  if (command === 'board') {
    const board = sessionID ? renderBoard(sessionID) : null;
    return [
      board ?? 'Nothing has been dispatched in this session yet, so the job board is empty.',
      '',
      'Report this to your human partner and stop. Do not take any other action.',
    ].join('\n');
  }

  return null;
};
