import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseConfigText, resolveSettings } from '../../core/config.js';

export const configDirectory = (env = process.env) =>
  env.CODEX_HOME || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.codex');
export function readConfig(file) {
  for (const candidate of [file, file.replace(/\.json$/, '.jsonc')]) {
    try {
      return parseConfigText(fs.readFileSync(candidate, 'utf8'), candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') console.error(`Superagent: ${error.message}`);
    }
  }
  return null;
}
export function loadConfig({
  configDir = configDirectory(),
  projectDir = process.cwd(),
  env = process.env,
  sessionPreset,
} = {}) {
  return resolveSettings({
    userFile: readConfig(path.join(configDir, 'superagent.json')),
    projectFile: readConfig(path.join(projectDir, '.codex', 'superagent.json')),
    stateFile: sessionPreset
      ? { preset: sessionPreset }
      : readConfig(path.join(configDir, 'superagent.state.json')),
    env,
  });
}
