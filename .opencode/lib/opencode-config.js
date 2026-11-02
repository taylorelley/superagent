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
import { stripJsonc } from './fs-utils.js';

/** OpenCode config files, lowest precedence first. */
export const opencodeConfigFiles = ({ configDir, projectDir, env = process.env } = {}) =>
  [
    configDir && path.join(configDir, 'opencode.json'),
    configDir && path.join(configDir, 'config.json'),
    env.OPENCODE_CONFIG,
    projectDir && path.join(projectDir, 'opencode.json'),
    projectDir && path.join(projectDir, '.opencode', 'opencode.json'),
  ].filter(Boolean);

/** Inline config from `OPENCODE_CONFIG_CONTENT`, the highest-precedence layer. */
const inlineConfig = (env = process.env) => {
  if (!env.OPENCODE_CONFIG_CONTENT) return null;
  try {
    const parsed = JSON.parse(stripJsonc(env.OPENCODE_CONFIG_CONTENT));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const readAll = (options = {}) =>
  [
    ...opencodeConfigFiles(options).map((file) => readConfigFile(file)),
    inlineConfig(options.env),
  ].filter(Boolean);

/** Whether any layer sets `default_agent`. */
export const defaultAgentConfigured = (options) =>
  readAll(options).some(
    (config) => typeof config.default_agent === 'string' && config.default_agent,
  );

/**
 * Whether a plugin target names this package — `superagent` as a whole path
 * segment or package name (`github:taylorelley/superagent#main`,
 * `superagent@git+…`, `/x/node_modules/superagent`), not merely containing it
 * (`superagent-tools`, `my-superagent`).
 */
export const isSuperagentTarget = (target) =>
  /(^|[/:])superagent(\.git)?($|[#@/]|::)/i.test(String(target).replace(/\\/g, '/'));

/** The configured plugin target (`github:…`, a path, a package spec) that is Superagent, if any. */
export const superagentPluginTarget = (options) => {
  for (const config of readAll(options).reverse()) {
    const listed = [config.plugins, config.plugin].flatMap((v) => (Array.isArray(v) ? v : []));
    for (const entry of listed) {
      const target = typeof entry === 'string' ? entry : (entry?.package ?? entry?.[0]);
      if (typeof target === 'string' && isSuperagentTarget(target)) return target;
    }
  }
  return null;
};
