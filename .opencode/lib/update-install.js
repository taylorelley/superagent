/**
 * Installing an update: shell out to `opencode`, `git`, or `npm`.
 *
 * OpenCode V2 installs package plugins itself (`opencode plugin add`) into its
 * own cache and updates them with `opencode plugin update <target>`, so that
 * is the first choice whenever Superagent is a configured package target. A
 * git checkout is pulled in place; anything else falls back to the npm
 * install `.opencode/INSTALL.md` documents.
 *
 * This is the one dependency exception AGENTS.md allows — a tool the user's
 * environment may already have, detected at runtime, never required, with a
 * fully-functional fallback (a reported manual command) when it is absent.
 * See the `git`/`gh-stack` precedent this follows in AGENTS.md.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { packageRoot, resolveConfigDir } from './paths.js';
import { superagentPluginTarget } from './opencode-config.js';
import { REPO_OWNER, REPO_NAME } from './update-check.js';

export const GIT_SPEC = `${REPO_NAME}@git+https://github.com/${REPO_OWNER}/${REPO_NAME}.git`;
export const PLUGIN_TARGET = `github:${REPO_OWNER}/${REPO_NAME}`;

/** A target `opencode plugin update` can act on: a package, not a local path. */
const isPackageTarget = (target) =>
  typeof target === 'string' && !/^(\.{0,2}\/|~\/|file:|[A-Za-z]:\\)/.test(target);

/**
 * Install the latest version in place.
 *
 * `dir` is the resolved package root: a git checkout when OpenCode's package
 * manager left one, or a plain `node_modules` copy otherwise — the two
 * install paths `.opencode/INSTALL.md` already documents as the real path and
 * its fallback. `execFileImpl` (callback-style, like `child_process.execFile`)
 * is injectable so tests never spawn a real process. Everything runs
 * asynchronously: this executes inside the OpenCode server, and a synchronous
 * `opencode plugin update` or `npm install` would stall it for its duration.
 *
 * Never throws. Returns `{ ok, method, output, error }` — a failure names the
 * exact manual command from `.opencode/INSTALL.md` so it's still actionable
 * from the TUI even when neither tool is available.
 */
/** Run a command without blocking; resolves `{ ok, output }`, never rejects. */
const runWith =
  (execFileImpl, cwd) =>
  (cmd, args, options = {}) =>
    new Promise((resolve) => {
      try {
        execFileImpl(
          cmd,
          args,
          { encoding: 'utf8', timeout: 60_000, cwd, ...options },
          (err, stdout, stderr) => {
            if (!err) return resolve({ ok: true, output: String(stdout ?? '') });
            const output = [err.stdout ?? stdout, err.stderr ?? stderr].filter(Boolean).join('\n');
            resolve({ ok: false, output: output || err.message });
          },
        );
      } catch (err) {
        resolve({ ok: false, output: err.message });
      }
    });

/** Expand `~` and `file://` in a local plugin target to an absolute path. */
const localTargetPath = (target, homeDir = os.homedir()) => {
  if (typeof target !== 'string') return null;
  const raw = target.startsWith('file://') ? target.slice('file://'.length) : target;
  if (raw === '~' || raw.startsWith('~/')) return path.join(homeDir, raw.slice(1));
  return path.resolve(raw);
};

export const performUpdate = async ({
  dir = packageRoot,
  configDir = resolveConfigDir(),
  projectDir,
  execFileImpl = execFile,
  hasGitCheckout = fs.existsSync(path.join(dir, '.git')),
  pluginTarget = superagentPluginTarget({ configDir, projectDir }),
} = {}) => {
  const run = runWith(execFileImpl, dir);
  const toolOnPath = async (cmd) =>
    (await run(process.platform === 'win32' ? 'where' : 'which', [cmd])).ok;

  if (hasGitCheckout) {
    if (!(await toolOnPath('git'))) {
      return {
        ok: false,
        method: 'git',
        output: '',
        error: `git is not on PATH. Update manually: cd ${dir} && git pull --ff-only`,
      };
    }
    const result = await run('git', ['-C', dir, 'pull', '--ff-only']);
    return {
      ok: result.ok,
      method: 'git pull',
      output: result.output,
      error: result.ok ? null : result.output,
    };
  }

  if (isPackageTarget(pluginTarget) && (await toolOnPath('opencode'))) {
    const result = await run('opencode', ['plugin', 'update', pluginTarget]);
    return {
      ok: result.ok,
      method: 'opencode plugin update',
      output: result.output,
      error: result.ok ? null : result.output,
    };
  }

  // A local directory target is only the npm fallback's own install location
  // when it is `<configDir>/node_modules/superagent`; anything else is a copy
  // the npm install below would not touch, so updating it is the user's call.
  const npmInstallDir = path.join(configDir, 'node_modules', REPO_NAME);
  if (pluginTarget && !isPackageTarget(pluginTarget)) {
    const local = localTargetPath(pluginTarget);
    if (local !== path.resolve(npmInstallDir)) {
      return {
        ok: false,
        method: 'local',
        output: '',
        error:
          `Superagent is loaded from the local directory ${local}, which is not a git checkout ` +
          'this command can pull. Update that copy yourself, or switch to ' +
          `\`opencode plugin add github:${REPO_OWNER}/${REPO_NAME}\`.`,
      };
    }
  }

  if (!(await toolOnPath('npm'))) {
    return {
      ok: false,
      method: 'npm',
      output: '',
      error: `npm is not on PATH. Update manually: npm install ${GIT_SPEC} --prefix ${configDir}`,
    };
  }
  const result = await run('npm', ['install', GIT_SPEC, '--prefix', configDir]);
  return {
    ok: result.ok,
    method: 'npm install',
    output: result.output,
    error: result.ok ? null : result.output,
  };
};
