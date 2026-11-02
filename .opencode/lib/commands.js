/**
 * Slash commands.
 *
 * OpenCode V2 registers a command as a name plus an `execute` function, which
 * receives the session and the prompt the user typed after the command. The
 * plugin entry wires `execute` to `expandCommand` below and submits the
 * expansion as the session's next prompt, so the expansion can depend on live
 * state the command definition cannot see: the councillors that were actually
 * registered, the live board, the resolved preset.
 */

import fs from 'fs';
import { councilInstruction } from './council.js';
import { stateFilePath } from './config-schema.js';
import { SHIPPED_PRESETS } from './presets.js';
import { renderBoard } from './board.js';
import { readCache, cachePath } from './update-check.js';
import { performUpdate } from './update-install.js';
import { warn } from './log.js';

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
 * `existing` is the set of command names OpenCode already has — the V2
 * command editor can only add, and a later registration would shadow the
 * user's own command of the same name, so collisions are filtered here, before
 * the transform, from `ctx.command.list()`.
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

/**
 * Explain what a preset switch can and cannot do.
 *
 * Being straight about this matters. A persisted preset is applied by
 * reloading the plugin's agent and command registrations (`onPersist`), which
 * changes what *new* dispatches get — but a session keeps the agent and model
 * it already selected. Reporting "switched" without saying so would leave the
 * user believing they are on a model they are not on.
 */
const presetReport = (settings, args, configDir, onPersist) => {
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

  if (!persisted) {
    return [
      `Preset "${name}" was not saved, so nothing changed.`,
      '',
      'Superagent reads its preset from `superagent.json` and the saved state file.',
      `Re-run as \`/preset ${name} --persist\` to save and apply it, or set "preset": "${name}" in superagent.json.`,
      '',
      'Tell your human partner exactly this and stop. Do not take any other action.',
    ].join('\n');
  }

  let applied = false;
  if (onPersist) {
    try {
      onPersist(name);
      applied = true;
    } catch (err) {
      warn(`could not apply preset: ${err.message}`);
    }
  }

  return [
    `Preset "${name}" saved.`,
    '',
    applied
      ? 'Superagent reloaded its agents and commands with it. **This session keeps the agent and model it already selected**; new dispatches and new sessions use the new definitions.'
      : '**It takes effect after `opencode service restart`.** Agent definitions — which agents exist, and which model each one is routed to — are registered when the plugin loads.',
    '',
    'Tell your human partner exactly this and stop. Do not take any other action.',
  ].join('\n');
};

/**
 * Report or act on the update check's cached result.
 *
 * `/update` reads what the last background check found — it never triggers a
 * fetch of its own, so the command is instant. `/update install` shells out
 * (`update-install.js`) and is honest that the change is not live until the
 * OpenCode service restarts: plugin code is imported once when it loads.
 */
const updateReport = (args, configDir) => {
  const [action] = args.trim().split(/\s+/).filter(Boolean);

  if (action === 'install') {
    const result = performUpdate({ configDir });
    return [
      result.ok
        ? `Update installed (${result.method}).`
        : `Update failed (${result.method}): ${result.error}`,
      '',
      '**This does not take effect until the OpenCode service restarts** (`opencode service restart`).',
      'Plugin code is imported once, when the plugin loads.',
      '',
      'Tell your human partner exactly this and stop. Do not take any other action.',
    ].join('\n');
  }

  const cache = readCache(cachePath(configDir));
  if (!cache) {
    return [
      'No update check has completed yet this session.',
      '',
      'Tell your human partner this and stop. Do not take any other action.',
    ].join('\n');
  }

  return [
    `Installed version: ${cache.currentVersion ?? 'unknown'}`,
    `Latest known version: ${cache.latestVersion ?? 'unknown'}`,
    `Last checked: ${cache.checkedAt ? new Date(cache.checkedAt).toISOString() : 'never'}`,
    cache.updateAvailable
      ? 'An update is available. Run `/update install` to install it.'
      : 'You are on the latest known version.',
    '',
    'Tell your human partner this and stop. Do not take any other action.',
  ].join('\n');
};

/**
 * Rewrite a command into its real instruction.
 *
 * Returns the replacement text, or null to leave the command alone.
 */
export const expandCommand = (
  command,
  args,
  { settings, councillors, configDir, sessionID, onPresetPersist },
) => {
  if (command === 'council') {
    return councilInstruction(councillors ?? [], (args ?? '').trim());
  }

  if (command === 'preset') {
    return presetReport(settings, args ?? '', configDir, onPresetPersist);
  }

  if (command === 'board') {
    const board = sessionID ? renderBoard(sessionID) : null;
    return [
      board ?? 'Nothing has been dispatched in this session yet, so the job board is empty.',
      '',
      'Report this to your human partner and stop. Do not take any other action.',
    ].join('\n');
  }

  if (command === 'update') {
    return updateReport(args ?? '', configDir);
  }

  return null;
};
