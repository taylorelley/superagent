import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Native update flow, invoked only by the explicit update install command. */
export function installUpdate({ configDir, projectDir, run = spawnSync }) {
  const env = { ...process.env, CODEX_HOME: configDir };
  const execute = (command, args) => {
    const result = run(command, args, {
      cwd: projectDir,
      env,
      encoding: 'utf8',
      timeout: 60000,
      maxBuffer: 1024 * 1024,
    });
    if (result.status !== 0)
      throw new Error(
        result.stderr?.trim() || result.error?.message || `${command} failed (${result.status})`,
      );
    return result.stdout;
  };
  let installed = false;
  try {
    execute('codex', ['plugin', 'marketplace', 'upgrade', 'superagent']);
    const plugin = JSON.parse(
      execute('codex', ['plugin', 'add', 'superagent@superagent', '--json']),
    );
    installed = true;
    if (typeof plugin.installedPath !== 'string' || !path.isAbsolute(plugin.installedPath))
      throw new Error('Codex did not return an absolute installed plugin path');
    execute('node', [path.join(plugin.installedPath, 'codex/install.mjs')]);
    return 'Superagent plugin and role files updated. Start a new Codex session to load the update.';
  } catch (error) {
    return `${installed ? 'Plugin updated, but role refresh failed' : 'Update failed'}: ${error.message}. Start a new session after resolving this.`;
  }
}
