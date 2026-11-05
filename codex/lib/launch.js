import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { installRoles } from '../install.mjs';
import { configDirectory, loadConfig } from './config.js';
import { createAdapter, toml } from './adapter.js';
import { toCodexModel } from './roster.js';

/** A per-configuration role cache keeps concurrent projects independent. */
export function prepareLaunch({
  configDir = configDirectory(),
  projectDir = process.cwd(),
  env = process.env,
} = {}) {
  const settings = loadConfig({ configDir, projectDir, env });
  const key = createHash('sha256')
    .update(path.resolve(projectDir) + '\0' + JSON.stringify(settings))
    .digest('hex')
    .slice(0, 24);
  const roleDir = path.join(configDir, 'superagent', 'roles', `${key}-${randomUUID()}`);
  const installed = installRoles({ configDir, projectDir, roleDir, settings });
  if (installed.actions.some((a) => a.action === 'conflict'))
    throw new Error(`Generated role cache has modified files: ${roleDir}`);
  const adapter = createAdapter(settings);
  // The V1 native backend exposes custom agent_type roles; V2 surfaces do not
  // consistently expose that contract. Keep this choice local to this launch.
  const args = ['-c', 'features.multi_agent_v2=false'];
  for (const role of adapter.specialists)
    args.push(
      '-c',
      `agents.${toml(role.name)}=${toml({ description: role.description, config_file: path.join(roleDir, `${role.name}.toml`) })}`,
    );
  const routed = toCodexModel(settings.agents.models.orchestrator);
  if (settings.agents.setDefaultAgent && !routed.warning)
    for (const [key, value] of Object.entries(routed)) args.push('-c', `${key}=${toml(value)}`);
  return {
    args,
    env: { ...env, CODEX_HOME: configDir, SUPERAGENT_ROLE_DIR: roleDir },
    roleDir,
    warnings: [...adapter.warnings, ...(routed.warning ? [routed.warning] : [])],
  };
}

/** Resolve Codex's explicit working-directory flags before reading project config. */
export function launchDirectory(args, cwd = process.cwd()) {
  let directory = cwd;
  for (let i = 0; i < args.length && args[i] !== '--'; i++) {
    if (args[i] === '-C' || args[i] === '--cd') {
      if (typeof args[i + 1] !== 'string') throw new Error('Codex --cd requires a directory');
      directory = path.resolve(cwd, args[++i]);
    } else if (args[i].startsWith('--cd=')) directory = path.resolve(cwd, args[i].slice(5));
    else if (args[i].startsWith('-C') && args[i].length > 2)
      directory = path.resolve(cwd, args[i].slice(2));
  }
  return directory;
}
