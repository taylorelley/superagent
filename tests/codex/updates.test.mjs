import test from 'node:test';
import assert from 'node:assert/strict';
import { installUpdate } from '../../codex/lib/updates.js';

test('native updater refreshes roles from the new plugin path and reports partial failure', () => {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, options });
    if (command === 'codex' && args[1] === 'add')
      return { status: 0, stdout: JSON.stringify({ installedPath: '/new/plugin' }) };
    if (command === 'node') return { status: 1, stderr: 'modified role file preserved' };
    return { status: 0, stdout: '' };
  };
  const result = installUpdate({ configDir: '/isolated/home', projectDir: '/project', run });
  assert.match(result, /Plugin updated, but role refresh failed/);
  assert.match(result, /modified role file preserved/);
  assert.deepEqual(calls.at(-1).args, ['/new/plugin/codex/install.mjs']);
  assert.equal(calls[0].options.env.CODEX_HOME, '/isolated/home');
});

test('failed marketplace refresh does not attempt plugin installation', () => {
  let calls = 0;
  const result = installUpdate({
    configDir: '/home',
    projectDir: '/project',
    run: () => {
      calls++;
      return { status: 1, stderr: 'offline' };
    },
  });
  assert.equal(calls, 1);
  assert.match(result, /Update failed: offline/);
});
