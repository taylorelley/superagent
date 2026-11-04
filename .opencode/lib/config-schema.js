/**
 * Superagent configuration for OpenCode: finds and reads the config files.
 *
 * Defaults, layering and validation live in `core/config.js`, shared with the
 * Claude Code plugin. Layers, later winning: defaults, the preset,
 *   user    ${OPENCODE_CONFIG_DIR:-~/.config/opencode}/superagent.json[c]
 *   project <directory>/.opencode/superagent.json[c]
 *   state   <configDir>/superagent.state.json (written by `/preset --persist`)
 *   environment overrides.
 */

import fs from 'fs';
import path from 'path';
import {
  CONFIG_BASENAME,
  envOverrides as coreEnvOverrides,
  parseConfigText,
  resolveSettings,
} from '../../core/config.js';

export { CONFIG_BASENAME, DEFAULTS, parseConfigText, resolveSettings } from '../../core/config.js';

/** Read a JSON/JSONC file, returning null when absent and warning when broken. */
export const readConfigFile = (filePath) => {
  for (const candidate of [filePath, `${filePath}c`]) {
    if (!fs.existsSync(candidate)) continue;
    let text;
    try {
      text = fs.readFileSync(candidate, 'utf8');
    } catch {
      return null;
    }
    return parseConfigText(text, candidate);
  }
  return null;
};

/** Environment overrides, applied last so they win over every file. */
export const envOverrides = (env = process.env) => coreEnvOverrides(env);

export const stateFilePath = (configDir) => path.join(configDir, `${CONFIG_BASENAME}.state.json`);

/**
 * Resolve the effective configuration.
 *
 * `configDir` is OpenCode's user config directory; `projectDir` is the
 * directory OpenCode was opened in.
 */
export const loadConfig = ({ configDir, projectDir, env = process.env } = {}) =>
  resolveSettings({
    userFile: configDir ? readConfigFile(path.join(configDir, `${CONFIG_BASENAME}.json`)) : null,
    projectFile: projectDir
      ? readConfigFile(path.join(projectDir, '.opencode', `${CONFIG_BASENAME}.json`))
      : null,
    // Written by `/preset <name> --persist`. Kept separate from the user's own
    // file so persisting a choice never rewrites their hand-edited config.
    stateFile: configDir ? readConfigFile(stateFilePath(configDir)) : null,
    env,
  });
