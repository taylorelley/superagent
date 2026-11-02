/**
 * The few facts Superagent needs from the user's own OpenCode config.
 *
 * V2 gives a plugin no global config object, and the agent editor can set the
 * default agent but not read it. So the one setting the plugin must respect —
 * a `default_agent` the user chose — and the one it must find to update itself
 * — its own entry in `plugins` — are read from the files directly, in
 * OpenCode's own precedence order. Read once at setup; never throws.
 */

import path from 'path';
import { readConfigFile } from './config-schema.js';

/** OpenCode config files, lowest precedence first. */
export const opencodeConfigFiles = ({ configDir, projectDir, env = process.env } = {}) =>
  [
    configDir && path.join(configDir, 'opencode.json'),
    configDir && path.join(configDir, 'config.json'),
    env.OPENCODE_CONFIG,
    projectDir && path.join(projectDir, 'opencode.json'),
    projectDir && path.join(projectDir, '.opencode', 'opencode.json'),
  ].filter(Boolean);

const readAll = (options) =>
  opencodeConfigFiles(options)
    .map((file) => readConfigFile(file))
    .filter(Boolean);

/** Whether any layer sets `default_agent`. */
export const defaultAgentConfigured = (options) =>
  readAll(options).some(
    (config) => typeof config.default_agent === 'string' && config.default_agent,
  );

/** The configured plugin target (`github:…`, a path, a package spec) that is Superagent, if any. */
export const superagentPluginTarget = (options) => {
  for (const config of readAll(options).reverse()) {
    for (const entry of [...(config.plugins ?? []), ...(config.plugin ?? [])]) {
      const target = typeof entry === 'string' ? entry : (entry?.package ?? entry?.[0]);
      if (typeof target === 'string' && /superagent/i.test(target)) return target;
    }
  }
  return null;
};
