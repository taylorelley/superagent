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
import { superagentPluginTarget, isSuperagentTarget } from '../../.opencode/lib/opencode-config.js';

/** A fake callback-style `execFile` driven by a map of command name -> behavior. */
const fakeExec =
  (behavior, calls = []) =>
  (cmd, args, _options, callback) => {
    calls.push([cmd, ...(args ?? [])]);
    const spec = behavior[cmd];
    if (!spec) {
      const err = new Error(`${cmd}: not found`);
      err.stderr = 'not found';
      return callback(err, '', 'not found');
    }
    if (spec.fail) {
      const err = new Error(spec.error ?? 'command failed');
      err.stdout = spec.stdout ?? '';
      err.stderr = spec.stderr ?? 'failed';
      return callback(err, err.stdout, err.stderr);
    }
    return callback(null, spec.output ?? '', '');
  };

test('performUpdate runs git pull when the install is a git checkout', async () => {
  const result = await performUpdate({
    dir: '/fake/pkg',
    hasGitCheckout: true,
    execFileImpl: fakeExec({
      which: { output: '/usr/bin/git' },
      git: { output: 'Already up to date.\n' },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'git pull');
  assert.match(result.output, /up to date/);
});

test('performUpdate reports a failed git pull without throwing', async () => {
  const result = await performUpdate({
    dir: '/fake/pkg',
    hasGitCheckout: true,
    execFileImpl: fakeExec({
      which: { output: '/usr/bin/git' },
      git: { fail: true, stderr: 'conflict' },
    }),
  });

  assert.equal(result.ok, false);
  assert.equal(result.method, 'git pull');
  assert.match(result.error, /conflict/);
});

test('performUpdate falls back to npm install when there is no git checkout', async () => {
  const result = await performUpdate({
    dir: '/fake/pkg',
    configDir: '/fake/config',
    hasGitCheckout: false,
    pluginTarget: null,
    execFileImpl: fakeExec({
      which: { output: '/usr/bin/npm' },
      npm: { output: 'added 1 package\n' },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'npm install');
});

test('performUpdate reports a missing git without throwing, naming the manual command', async () => {
  const result = await performUpdate({
    dir: '/fake/pkg',
    hasGitCheckout: true,
    execFileImpl: fakeExec({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.method, 'git');
  assert.match(result.error, /git pull --ff-only/);
});

test('performUpdate reports a missing npm without throwing, naming the manual command', async () => {
  const result = await performUpdate({
    dir: '/fake/pkg',
    configDir: '/fake/config',
    hasGitCheckout: false,
    pluginTarget: null,
    execFileImpl: fakeExec({}),
  });

  assert.equal(result.ok, false);
  assert.equal(result.method, 'npm');
  assert.match(result.error, new RegExp(GIT_SPEC.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(result.error, /--prefix \/fake\/config/);
});

test('performUpdate uses `opencode plugin update` for a configured package target', async () => {
  const calls = [];
  const result = await performUpdate({
    dir: '/fake/cache/node_modules/superagent',
    hasGitCheckout: false,
    pluginTarget: 'github:taylorelley/superagent',
    execFileImpl: fakeExec(
      { which: { output: '/usr/bin/opencode' }, opencode: { output: 'updated\n' } },
      calls,
    ),
  });

  assert.equal(result.ok, true);
  assert.equal(result.method, 'opencode plugin update');
  assert.deepEqual(calls.at(-1), ['opencode', 'plugin', 'update', 'github:taylorelley/superagent']);
});

test('a local-path plugin target is not handed to `opencode plugin update`', async () => {
  const calls = [];
  await performUpdate({
    dir: '/fake/pkg',
    configDir: '/fake/config',
    hasGitCheckout: false,
    pluginTarget: '~/src/superagent',
    execFileImpl: fakeExec(
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

test('a local directory that is not the npm fallback location is reported, not npm-installed over', async () => {
  const calls = [];
  const result = await performUpdate({
    dir: '/src/superagent',
    configDir: '/fake/config',
    hasGitCheckout: false,
    pluginTarget: '/src/superagent',
    execFileImpl: fakeExec({ which: { output: '/usr/bin/x' }, npm: { output: '' } }, calls),
  });
  assert.equal(result.ok, false);
  assert.equal(result.method, 'local');
  assert.match(result.error, /\/src\/superagent/);
  assert.ok(!calls.some(([cmd]) => cmd === 'npm'), 'npm installed a different copy');
});

test('the npm fallback location itself is still updated with npm', async () => {
  const result = await performUpdate({
    dir: '/fake/config/node_modules/superagent',
    configDir: '/fake/config',
    hasGitCheckout: false,
    pluginTarget: '/fake/config/node_modules/superagent',
    execFileImpl: fakeExec({ which: { output: '/usr/bin/npm' }, npm: { output: 'ok' } }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.method, 'npm install');
});

test('isSuperagentTarget matches this package, not a name that merely contains it', () => {
  for (const yes of [
    'github:taylorelley/superagent',
    'github:taylorelley/superagent#main',
    'superagent@git+https://github.com/taylorelley/superagent.git',
    '/home/u/.config/opencode/node_modules/superagent',
    'superagent',
  ]) {
    assert.ok(isSuperagentTarget(yes), yes);
  }
  for (const no of ['github:example/superagent-tools', 'my-superagent', 'superagentic']) {
    assert.ok(!isSuperagentTarget(no), no);
  }
});

test('superagentPluginTarget skips a non-array plugins value instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-target-'));
  try {
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ plugins: { not: 'a list' }, plugin: ['github:example/superagent-tools'] }),
    );
    assert.equal(superagentPluginTarget({ configDir: dir, env: {} }), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('superagentPluginTarget finds a target configured only for the project', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-target-'));
  try {
    const projectDir = path.join(dir, 'project');
    fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, '.opencode', 'opencode.json'),
      JSON.stringify({ plugins: ['github:taylorelley/superagent'] }),
    );
    assert.equal(
      superagentPluginTarget({ configDir: path.join(dir, 'none'), projectDir, env: {} }),
      'github:taylorelley/superagent',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
