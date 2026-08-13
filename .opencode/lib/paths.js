/**
 * Path resolution for the OpenCode plugin.
 *
 * Layout, relative to this file at `<packageRoot>/.opencode/lib/paths.js`:
 *
 *   <packageRoot>/skills/              shared, harness-neutral skills
 *   <packageRoot>/.opencode/lib/       plugin source (here)
 *   <packageRoot>/.opencode/prompts/   agent prompts
 *   <packageRoot>/.opencode/config/    shipped defaults and presets
 *   <packageRoot>/.opencode/plugins/   plugin entry point (package.json "main")
 *
 * OpenCode registers the plugin through a symlink into its own config
 * directory. Node and Bun both resolve a symlinked module to its realpath
 * before resolving relative imports, so `../..` lands on the real package root
 * rather than the symlink's directory.
 */

import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { normalizePath } from './fs-utils.js';

const libDir = path.dirname(fileURLToPath(import.meta.url));

export const opencodeDir = path.resolve(libDir, '..');
export const packageRoot = path.resolve(libDir, '../..');
export const skillsDir = path.join(packageRoot, 'skills');
export const promptsDir = path.join(opencodeDir, 'prompts');
export const shippedConfigDir = path.join(opencodeDir, 'config');

/**
 * Where OpenCode keeps user-level configuration.
 *
 * `OPENCODE_CONFIG_DIR` wins when set — the test harness relies on it for
 * isolation — otherwise the documented default.
 */
export const resolveConfigDir = (env = process.env, homeDir = os.homedir()) => {
  const fromEnv = normalizePath(env.OPENCODE_CONFIG_DIR, homeDir);
  return fromEnv || path.join(homeDir, '.config/opencode');
};
