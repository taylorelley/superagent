/**
 * Unit tests for the update-install module.
 *
 * `execFileSyncImpl` is always injected — these tests never spawn a real
 * `opencode`, `git`, or `npm` process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GIT_SPEC, performUpdate } from '../../.opencode/lib/update-install.js';
import { superagentPluginTarget } from '../../.opencode/lib/opencode-config.js';

/** A fake `execFileSync` driven by a map of command name -> behavior. */
const fakeExec =
  (behavior, calls = []) =>
  (cmd, args) => {
    calls.push([cmd, ...(args ?? [])]);
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
    pluginTarget: null,
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
    pluginTarget: null,
    execFileSyncImpl: fakeExec({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.method, 'npm');
  assert.match(result.error, new RegExp(GIT_SPEC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.error, /--prefix \/fake\/config/);
});

test('performUpdate uses `opencode plugin update` for a configured package target', () => {
  const calls = [];
  const result = performUpdate({
    dir: '/fake/cache/node_modules/superagent',
    hasGitCheckout: false,
    pluginTarget: 'github:taylorelley/superagent',
    execFileSyncImpl: fakeExec(
      { which: { output: '/usr/bin/opencode' }, opencode: { output: 'updated\n' } },
      calls,
    ),
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'opencode plugin update');
  assert.deepEqual(calls.at(-1), ['opencode', 'plugin', 'update', 'github:taylorelley/superagent']);
});

test('a local-path plugin target is not handed to `opencode plugin update`', () => {
  const calls = [];
  performUpdate({
    dir: '/fake/pkg',
    configDir: '/fake/config',
    hasGitCheckout: false,
    pluginTarget: '~/src/superagent',
    execFileSyncImpl: fakeExec(
      { which: { output: '/usr/bin/x' }, npm: { output: '' }, opencode: { output: '' } },
      calls,
    ),
  });
  assert.ok(!calls.some(([cmd]) => cmd === 'opencode'), 'a path target was passed to opencode');
});

test('superagentPluginTarget finds the entry in either V2 or V1 config shape', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-target-'));
  try {
    assert.equal(superagentPluginTarget({ configDir: dir, env: {} }), null);
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ plugins: ['other', { package: 'github:taylorelley/superagent#main' }] }),
    );
    assert.equal(
      superagentPluginTarget({ configDir: dir, env: {} }),
      'github:taylorelley/superagent#main',
    );
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ plugin: ['superagent@git+x'] }),
    );
    assert.equal(superagentPluginTarget({ configDir: dir, env: {} }), 'superagent@git+x');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
