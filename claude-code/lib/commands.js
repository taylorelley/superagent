/**
 * What Superagent's slash commands say on Claude Code.
 *
 * On OpenCode a command's expansion is submitted as the next prompt, so its
 * text is addressed to the model ("tell your human partner this and stop").
 * Claude Code runs a registered command in the plugin and prints its answer
 * straight into the transcript, with no model turn, so these texts are
 * addressed to the person. `/council` is the exception: it needs the model,
 * and its instruction is submitted as a prompt.
 *
 * Pure text; the hooks module does the reading, writing and reloading.
 */

import { SHIPPED_PRESETS } from '../../core/presets.js';

const presetNames = (settings) =>
  Object.keys({ ...SHIPPED_PRESETS, ...(settings?.presets ?? {}) }).sort();

/**
 * Parse `/preset` arguments into what to do.
 *
 * Returns `{ text }` for something that only reports, or `{ persist: name }`
 * when a preset should be saved and applied.
 */
export const presetCommand = (settings, args) => {
  const [name, ...flags] = String(args ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const known = presetNames(settings);

  if (!name || name === 'show') {
    return {
      text: [
        `Active preset: ${settings.preset}`,
        `Agents: ${settings.agents.enabled ? 'on' : 'off'} · Board: ${settings.board.enabled ? 'on' : 'off'} · Council: ${settings.council.enabled ? 'on' : 'off'}`,
        `Available: ${known.join(', ')}`,
      ].join('\n'),
    };
  }
  if (name === 'list') {
    return {
      text: [
        'Superagent presets:',
        ...known.map((key) => `  - ${key}${key === settings.preset ? '  (active)' : ''}`),
      ].join('\n'),
    };
  }
  if (!known.includes(name)) {
    return { text: `There is no preset named "${name}". Available: ${known.join(', ')}.` };
  }
  if (!flags.includes('--persist')) {
    return {
      text: [
        `Preset "${name}" was not saved, so nothing changed.`,
        `Re-run as /preset ${name} --persist to save and apply it, or set "preset": "${name}" in superagent.json.`,
      ].join('\n'),
    };
  }
  return { persist: name };
};

/** The answer once a preset was (or could not be) saved. */
export const presetSavedText = (name, { saved, applied, stateFile }) => {
  if (!saved) {
    return [
      `Preset "${name}" could not be saved, so nothing changed.`,
      `Check that ${stateFile} is writable.`,
    ].join('\n');
  }
  return [
    `Preset "${name}" saved to ${stateFile}.`,
    applied
      ? 'Superagent re-registered its agents and commands with it: new dispatches use the new definitions from the next turn. This session keeps the orchestrator role and session context it started with; new sessions get the new preset in full.'
      : 'It takes effect in new sessions (or after /reload-plugins).',
  ].join('\n');
};

/** `/board`. */
export const boardText = (rendered) =>
  rendered ?? 'Nothing has been dispatched in this session yet, so the job board is empty.';

/** `/update` without arguments: what the last background check found. */
export const updateText = (cache) => {
  if (!cache) return 'No update check has completed yet.';
  return [
    `Installed version: ${cache.currentVersion ?? 'unknown'}`,
    `Latest known version: ${cache.latestVersion ?? 'unknown'}`,
    `Last checked: ${cache.checkedAt ? new Date(cache.checkedAt).toISOString() : 'never'}`,
    cache.updateAvailable
      ? 'An update is available. Run /update install to install it.'
      : 'You are on the latest known version.',
  ].join('\n');
};

/**
 * How `/update install` updates this copy, in order of preference: a git
 * checkout (a `--plugin-dir` clone) is pulled in place; an installed plugin is
 * updated by Claude Code's own `claude plugin update`. Returns the argv to
 * run, and the manual command to report when it cannot be run.
 */
export const updatePlan = ({ isGitCheckout, root, pluginId }) =>
  isGitCheckout
    ? {
        method: 'git pull',
        argv: ['git', '-C', root, 'pull', '--ff-only'],
        manual: `cd ${root} && git pull --ff-only`,
      }
    : {
        method: 'claude plugin update',
        argv: ['claude', 'plugin', 'update', pluginId],
        manual: `claude plugin update ${pluginId}`,
      };

/** The answer once `/update install` ran. */
export const installText = (plan, { ok, output }) =>
  [
    ok
      ? `Update installed (${plan.method}).`
      : `Update failed (${plan.method}): ${String(output ?? '').trim() || 'no output'}\nUpdate manually: ${plan.manual}`,
    'It takes effect after /reload-plugins, or in a new session: plugin code is loaded once, when the plugin loads.',
  ].join('\n');

/** `/council` when there is no council to convene. */
export const councilUnavailableText = (settings) =>
  [
    settings?.council?.enabled
      ? 'The council needs at least two members, with distinct models, before it can convene.'
      : 'The council is off in this preset.',
    'Configure it in superagent.json, for example:',
    '',
    '  {',
    '    "council": {',
    '      "enabled": true,',
    '      "members": [',
    '        { "name": "alpha", "model": "opus", "steering": "correctness and edge cases" },',
    '        { "name": "beta",  "model": "sonnet", "steering": "simplicity and maintainability" }',
    '      ]',
    '    }',
    '  }',
  ].join('\n');
