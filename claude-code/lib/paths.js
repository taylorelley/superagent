/**
 * Where Superagent's files live on Claude Code.
 *
 * Mirrors the OpenCode layout under Claude Code's own directories:
 *
 * | | OpenCode | Claude Code |
 * |---|---|---|
 * | user config | `~/.config/opencode/superagent.json` | `~/.claude/superagent.json` |
 * | project config | `<project>/.opencode/superagent.json` | `<project>/.claude/superagent.json` |
 * | saved preset | `~/.config/opencode/superagent.state.json` | `~/.claude/superagent.state.json` |
 *
 * `CLAUDE_CONFIG_DIR` moves the user directory, as it does for Claude Code.
 * Pure: the hooks module reads the environment and passes it in.
 */

import { CONFIG_BASENAME } from '../../core/config.js';

const join = (...parts) =>
  parts
    .filter((p) => typeof p === 'string' && p)
    .join('/')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/');

/** Claude Code's user directory, or null when no home is known. */
export const claudeConfigDir = (env = {}) => {
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR);
  const home = env.HOME || env.USERPROFILE;
  return home ? join(home, '.claude') : null;
};

/** Every config file, in merge order, with the `.jsonc` spelling accepted too. */
export const configFiles = ({ configDir, projectDir }) => ({
  user: configDir ? join(configDir, `${CONFIG_BASENAME}.json`) : null,
  project: projectDir ? join(projectDir, '.claude', `${CONFIG_BASENAME}.json`) : null,
  state: configDir ? join(configDir, `${CONFIG_BASENAME}.state.json`) : null,
});

/** A file inside the plugin. */
export const pluginFile = (root, relative) => join(root, relative);
