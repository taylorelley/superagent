/**
 * Installing an update: shell out to `git` or `npm`.
 *
 * This is the one dependency exception AGENTS.md allows — a tool the user's
 * environment may already have, detected at runtime, never required, with a
 * fully-functional fallback (a reported manual command) when it is absent.
 * See the `git`/`gh-stack` precedent this follows in AGENTS.md.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { packageRoot, resolveConfigDir } from './paths.js';
import { REPO_OWNER, REPO_NAME } from './update-check.js';

export const GIT_SPEC = `${REPO_NAME}@git+https://github.com/${REPO_OWNER}/${REPO_NAME}.git`;

/**
 * Install the latest version in place.
 *
 * `dir` is the resolved package root: a git checkout when OpenCode's package
 * manager left one, or a plain `node_modules` copy otherwise — the two
 * install paths `.opencode/INSTALL.md` already documents as the real path and
 * its fallback. `execFileSyncImpl` is injectable so tests never spawn a real
 * process.
 *
 * Never throws. Returns `{ ok, method, output, error }` — a failure names the
 * exact manual command from `.opencode/INSTALL.md` so it's still actionable
 * from the TUI even when neither tool is available.
 */
export const performUpdate = ({
  dir = packageRoot,
  configDir = resolveConfigDir(),
  execFileSyncImpl = execFileSync,
  hasGitCheckout = fs.existsSync(path.join(dir, '.git')),
} = {}) => {
  const toolOnPath = (cmd) => {
    try {
      execFileSyncImpl(process.platform === 'win32' ? 'where' : 'which', [cmd], {
        stdio: 'ignore',
      });
      return true;
    } catch {
      return false;
    }
  };

  const run = (cmd, args) => {
    try {
      const output = execFileSyncImpl(cmd, args, { encoding: 'utf8', timeout: 60_000, cwd: dir });
      return { ok: true, output: String(output ?? '') };
    } catch (err) {
      return {
        ok: false,
        output: [err.stdout, err.stderr].filter(Boolean).join('\n') || err.message,
      };
    }
  };

  if (hasGitCheckout) {
    if (!toolOnPath('git')) {
      return {
        ok: false,
        method: 'git',
        output: '',
        error: `git is not on PATH. Update manually: cd ${dir} && git pull --ff-only`,
      };
    }
    const result = run('git', ['-C', dir, 'pull', '--ff-only']);
    return {
      ok: result.ok,
      method: 'git pull',
      output: result.output,
      error: result.ok ? null : result.output,
    };
  }

  if (!toolOnPath('npm')) {
    return {
      ok: false,
      method: 'npm',
      output: '',
      error: `npm is not on PATH. Update manually: npm install ${GIT_SPEC} --prefix ${configDir}`,
    };
  }
  const result = run('npm', ['install', GIT_SPEC, '--prefix', configDir]);
  return {
    ok: result.ok,
    method: 'npm install',
    output: result.output,
    error: result.ok ? null : result.output,
  };
};
