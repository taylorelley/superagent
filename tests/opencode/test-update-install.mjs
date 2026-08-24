/**
 * Unit tests for the update-install module.
 *
 * `execFileSyncImpl` is always injected — these tests never spawn a real
 * `git` or `npm` process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { GIT_SPEC, performUpdate } from '../../.opencode/lib/update-install.js';

/** A fake `execFileSync` driven by a map of command name -> behavior. */
const fakeExec = (behavior) => (cmd) => {
  const spec = behavior[cmd];
  if (!spec) {
    const err = new Error(`${cmd}: not found`);
    err.stdout = '';
    err.stderr = 'not found';
    throw err;
  }
  if (spec.fail) {
    const err = new Error(spec.error ?? 'command failed');
    err.stdout = spec.stdout ?? '';
    err.stderr = spec.stderr ?? 'failed';
    throw err;
  }
  return spec.output ?? '';
};

test('performUpdate runs git pull when the install is a git checkout', () => {
  const result = performUpdate({
    dir: '/fake/pkg',
    hasGitCheckout: true,
    execFileSyncImpl: fakeExec({
      which: { output: '/usr/bin/git' },
      git: { output: 'Already up to date.\n' },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'git pull');
  assert.match(result.output, /up to date/);
});

test('performUpdate reports a failed git pull without throwing', () => {
  const result = performUpdate({
    dir: '/fake/pkg',
    hasGitCheckout: true,
    execFileSyncImpl: fakeExec({
      which: { output: '/usr/bin/git' },
      git: { fail: true, stderr: 'conflict' },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.method, 'git pull');
  assert.match(result.error, /conflict/);
});

test('performUpdate falls back to npm install when there is no git checkout', () => {
  const result = performUpdate({
    dir: '/fake/pkg',
    configDir: '/fake/config',
    hasGitCheckout: false,
    execFileSyncImpl: fakeExec({
      which: { output: '/usr/bin/npm' },
      npm: { output: 'added 1 package\n' },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'npm install');
});

test('performUpdate reports a missing git without throwing, naming the manual command', () => {
  const result = performUpdate({
    dir: '/fake/pkg',
    hasGitCheckout: true,
    execFileSyncImpl: fakeExec({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.method, 'git');
  assert.match(result.error, /git pull --ff-only/);
});

test('performUpdate reports a missing npm without throwing, naming the manual command', () => {
  const result = performUpdate({
    dir: '/fake/pkg',
    configDir: '/fake/config',
    hasGitCheckout: false,
    execFileSyncImpl: fakeExec({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.method, 'npm');
  assert.match(result.error, new RegExp(GIT_SPEC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.error, /--prefix \/fake\/config/);
});
