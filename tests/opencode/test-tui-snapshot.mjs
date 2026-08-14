/**
 * Unit tests for the TUI snapshot bridge.
 *
 * The panel runs in a different process from the plugin, so this file is the
 * whole contract between them. It has to be dull: no throwing, no clobbering,
 * no half-written reads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  MAX_SESSIONS,
  SNAPSHOT_VERSION,
  pruneSessions,
  readSnapshot,
  resetSnapshotCache,
  sessionRecords,
  snapshotPath,
  writeSnapshot,
} from '../../.opencode/lib/tui-snapshot.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-tui-'));

const session = (records = [], updatedAt = 1) => ({ updatedAt, records });

// ------------------------------------------------------------------- paths

test('snapshotPath keys the file by project, so two projects never collide', () => {
  const configDir = '/config';
  const one = snapshotPath(configDir, '/work/alpha');
  const two = snapshotPath(configDir, '/work/beta');

  assert.notEqual(one, two);
  assert.equal(path.dirname(one), path.dirname(two), 'both live under the same directory');
  assert.match(path.basename(one), /^tui-[0-9a-f]{12}\.json$/);
});

test('snapshotPath is stable across equivalent spellings of the same project', () => {
  assert.equal(
    snapshotPath('/config', '/work/alpha'),
    snapshotPath('/config', '/work/alpha/'),
    'a trailing slash is the same project'
  );
  assert.equal(snapshotPath('/config', null), snapshotPath('/config', undefined));
});

test('snapshotPath without a config directory has nowhere to write', () => {
  assert.equal(snapshotPath(null, '/work/alpha'), null);
});

// ------------------------------------------------------------------ pruning

test('pruneSessions keeps the most recently updated sessions', () => {
  const sessions = {};
  for (let i = 0; i < MAX_SESSIONS + 5; i += 1) sessions[`s${i}`] = session([], i);

  const pruned = pruneSessions(sessions);

  assert.equal(Object.keys(pruned).length, MAX_SESSIONS);
  assert.ok(pruned[`s${MAX_SESSIONS + 4}`], 'the newest survives');
  assert.equal(pruned.s0, undefined, 'the oldest is dropped');
});

test('pruneSessions leaves a small board alone', () => {
  const sessions = { a: session([], 1), b: session([], 2) };
  assert.deepEqual(pruneSessions(sessions), sessions);
  assert.deepEqual(pruneSessions(undefined), {});
});

// ------------------------------------------------------------ write / read

test('a snapshot round-trips', () => {
  resetSnapshotCache();
  const dir = tempDir();
  const file = snapshotPath(dir, '/work/alpha');
  const records = [{ agent: 'implementer', objective: 'work', state: 'running', owns: ['src/**'] }];

  assert.equal(
    writeSnapshot(file, {
      directory: '/work/alpha',
      pluginVersion: '0.1.0',
      sessions: { s1: session(records) },
    }),
    true
  );

  const read = readSnapshot(file);
  assert.equal(read.version, SNAPSHOT_VERSION);
  assert.equal(read.pluginVersion, '0.1.0');
  assert.equal(read.directory, '/work/alpha');
  assert.deepEqual(sessionRecords(read, 's1'), records);
  assert.deepEqual(sessionRecords(read, 'missing'), [], 'an unknown session is empty, not an error');
});

test('a version-1 snapshot from an older plugin copy is rejected', () => {
  const dir = tempDir();
  const file = path.join(dir, 'old.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: { s1: session() } }));

  assert.equal(readSnapshot(file), null, 'an old format is not read as the current one');
});

test('writing an unchanged board does no work', () => {
  resetSnapshotCache();
  const dir = tempDir();
  const file = snapshotPath(dir, '/work/alpha');
  const payload = { directory: '/work/alpha', sessions: { s1: session([{ agent: 'oracle' }]) } };

  assert.equal(writeSnapshot(file, payload), true);
  const first = fs.statSync(file).mtimeMs;

  assert.equal(writeSnapshot(file, payload), false, 'identical bytes are not rewritten');
  assert.equal(fs.statSync(file).mtimeMs, first, 'so the panel is not woken for nothing');

  payload.sessions.s1.records.push({ agent: 'librarian' });
  assert.equal(writeSnapshot(file, payload), true, 'a real change still writes');
});

test('writing leaves no temp file behind for the panel to find', () => {
  resetSnapshotCache();
  const dir = tempDir();
  const file = snapshotPath(dir, '/work/alpha');
  writeSnapshot(file, { sessions: { s1: session() } });

  const stray = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('tmp'));
  assert.deepEqual(stray, []);
});

test('writing prunes, so a long-lived config directory does not grow forever', () => {
  resetSnapshotCache();
  const dir = tempDir();
  const file = snapshotPath(dir, '/work/alpha');
  const sessions = {};
  for (let i = 0; i < MAX_SESSIONS + 3; i += 1) sessions[`s${i}`] = session([], i);

  writeSnapshot(file, { sessions });

  assert.equal(Object.keys(readSnapshot(file).sessions).length, MAX_SESSIONS);
});

// -------------------------------------------------------------- degradation

test('reading what is not there is not an error', () => {
  const dir = tempDir();
  assert.equal(readSnapshot(path.join(dir, 'absent.json')), null);
  assert.equal(readSnapshot(null), null);
  assert.deepEqual(sessionRecords(null, 's1'), []);
});

test('a corrupt or foreign snapshot reads as nothing rather than throwing', () => {
  const dir = tempDir();

  const truncated = path.join(dir, 'truncated.json');
  fs.writeFileSync(truncated, '{"version": 1, "sessions": {');
  assert.equal(readSnapshot(truncated), null);

  const array = path.join(dir, 'array.json');
  fs.writeFileSync(array, '[]');
  assert.equal(readSnapshot(array), null);

  const future = path.join(dir, 'future.json');
  fs.writeFileSync(future, JSON.stringify({ version: SNAPSHOT_VERSION + 1, sessions: { s1: session() } }));
  assert.equal(readSnapshot(future), null, 'a newer format is not guessed at');
});

test('an unwritable destination is reported, not thrown', () => {
  resetSnapshotCache();
  const dir = tempDir();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory');

  assert.equal(writeSnapshot(path.join(blocker, 'nested', 'tui.json'), { sessions: {} }), false);
});

// ------------------------------------------------------------- the wiring

test('a dispatch through the plugin lands in a snapshot the panel can read', async () => {
  resetSnapshotCache();
  const configDir = tempDir();
  const projectDir = tempDir();

  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  try {
    const { SuperagentPlugin } = await import('../../.opencode/plugins/superagent.js');
    const plugin = await SuperagentPlugin({ client: {}, directory: projectDir });

    await plugin['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1', callID: 'call_1' },
      { args: { subagent_type: 'implementer', description: 'Wire the panel' } }
    );

    const snapshot = readSnapshot(snapshotPath(configDir, projectDir));
    assert.equal(snapshot.directory, projectDir);
    assert.equal(sessionRecords(snapshot, 'ses_1')[0].agent, 'implementer');

    await plugin['tool.execute.after'](
      { tool: 'task', sessionID: 'ses_1', callID: 'call_1' },
      { output: 'done' }
    );

    const after = readSnapshot(snapshotPath(configDir, projectDir));
    assert.equal(sessionRecords(after, 'ses_1')[0].state, 'completed');
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test('a tool call that is not a dispatch writes nothing', async () => {
  resetSnapshotCache();
  const configDir = tempDir();
  const projectDir = tempDir();

  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  try {
    const { SuperagentPlugin } = await import('../../.opencode/plugins/superagent.js');
    const plugin = await SuperagentPlugin({ client: {}, directory: projectDir });

    await plugin['tool.execute.before']({ tool: 'bash', sessionID: 'ses_1' }, { args: {} });
    await plugin.event({ event: { type: 'message.updated', properties: { sessionID: 'ses_1' } } });

    assert.equal(readSnapshot(snapshotPath(configDir, projectDir)), null);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});

test('the panel is not fed when it is switched off', async () => {
  resetSnapshotCache();
  const configDir = tempDir();
  const projectDir = tempDir();
  fs.writeFileSync(path.join(configDir, 'superagent.json'), JSON.stringify({ tui: { enabled: false } }));

  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  try {
    const { SuperagentPlugin } = await import('../../.opencode/plugins/superagent.js');
    const plugin = await SuperagentPlugin({ client: {}, directory: projectDir });

    await plugin['tool.execute.before'](
      { tool: 'task', sessionID: 'ses_1', callID: 'call_1' },
      { args: { subagent_type: 'implementer', description: 'Wire the panel' } }
    );

    assert.equal(readSnapshot(snapshotPath(configDir, projectDir)), null);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
});
