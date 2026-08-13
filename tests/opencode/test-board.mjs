/**
 * Unit tests for the job board and ownership checking.
 *
 * These drive the plugin's hooks with synthetic payloads shaped like the ones
 * OpenCode sends, so they need no binary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOwnership, globsOverlap, findConflicts } from '../../.opencode/lib/ownership.js';
import {
  onDispatch,
  onDispatchResult,
  onSessionEvent,
  renderBoard,
  injectBoard,
  boardSnapshots,
  resetBoards,
  BOARD_MARKER,
} from '../../.opencode/lib/board.js';
import { loadConfig } from '../../.opencode/lib/config-schema.js';

const settings = () => loadConfig({ env: {} });

const userMessage = (sessionID, text = 'hello') => ({
  info: { role: 'user', sessionID },
  parts: [{ type: 'text', text }],
});

// ------------------------------------------------------------- ownership

test('parseOwnership reads a declaration, and distinguishes absent from empty', () => {
  assert.equal(parseOwnership('no marker here'), null, 'absent must be distinguishable');
  assert.deepEqual(
    parseOwnership('do work\n<!-- superagent-ownership: write=src/api/**,src/db/**; read=src/** -->\n'),
    { write: ['src/api/**', 'src/db/**'], read: ['src/**'] }
  );
  assert.deepEqual(parseOwnership('<!-- superagent-ownership: read=src/** -->'), {
    write: [],
    read: ['src/**'],
  });
});

test('globsOverlap errs toward reporting a conflict', () => {
  assert.ok(globsOverlap('src/api/**', 'src/api/**'));
  assert.ok(globsOverlap('src/**', 'src/api/handler.ts'));
  assert.ok(globsOverlap('src/api/**', 'src/**'));
  assert.ok(!globsOverlap('src/api/**', 'docs/**'));
  assert.ok(!globsOverlap('src/api/**', 'src/db/**'));
});

test('findConflicts only considers write claims against write claims', () => {
  const running = [
    { id: 'a', agent: 'implementer', objective: 'api', ownership: { write: ['src/api/**'], read: [] } },
    { id: 'b', agent: 'implementer', objective: 'docs', ownership: { write: ['docs/**'], read: [] } },
  ];
  assert.deepEqual(findConflicts({ write: ['src/api/routes.ts'] }, running).map((r) => r.id), ['a']);
  assert.deepEqual(findConflicts({ write: ['test/**'] }, running), []);
  // A read-only dispatch cannot collide with anyone.
  assert.deepEqual(findConflicts({ write: [], read: ['src/**'] }, running), []);
});

// ----------------------------------------------------------------- board

test('a foreground dispatch is recorded and completed', () => {
  resetBoards();
  const s = settings();
  const args = { subagent_type: 'implementer', description: 'Task 1', prompt: 'do it' };

  onDispatch('root', 'call-1', args, s);
  assert.match(renderBoard('root'), /implementer \| Task 1 \| running/);

  onDispatchResult('root', 'call-1', { output: 'done, all tests pass' }, s);
  const board = renderBoard('root');
  assert.match(board, /implementer \| Task 1 \| completed/);
  assert.match(board, /0 still running/);
});

test('a background dispatch stays running until its session ends', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'call-1', { subagent_type: 'implementer', description: 'Task 1', background: true }, s);

  // The tool returns as soon as the job launches — that is not completion.
  onDispatchResult('root', 'call-1', { metadata: { background: true, jobId: 'child-9' } }, s);
  assert.match(renderBoard('root'), /running \(bg\)/);

  onSessionEvent('session.idle', 'child-9');
  assert.match(renderBoard('root'), /completed/);
});

test('a failed background dispatch is recorded as an error, not a completion', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'T', background: true }, s);
  onDispatchResult('root', 'c1', { metadata: { background: true, jobId: 'child-1' } }, s);
  onSessionEvent('session.error', 'child-1');
  assert.match(renderBoard('root'), /\| error \(bg\) \|/);
});

test('an unrelated session event does not touch the board', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'T', background: true }, s);
  onDispatchResult('root', 'c1', { metadata: { background: true, jobId: 'child-1' } }, s);
  onSessionEvent('session.idle', 'some-other-session');
  assert.match(renderBoard('root'), /running/);
});

test('conflicting write claims annotate the second dispatch', () => {
  resetBoards();
  const s = settings();
  const first = {
    subagent_type: 'implementer',
    description: 'API',
    prompt: '<!-- superagent-ownership: write=src/api/** -->\nbuild the api',
  };
  const second = {
    subagent_type: 'implementer',
    description: 'Routes',
    prompt: '<!-- superagent-ownership: write=src/api/routes.ts -->\nedit routes',
  };

  onDispatch('root', 'c1', first, s);
  onDispatch('root', 'c2', second, s);

  assert.match(second.prompt, /SUPERAGENT_OWNERSHIP_CONFLICT/, 'second dispatch was not warned');
  assert.match(second.prompt, /src\/api\/\*\*/, 'conflict notice should name the conflicting claim');
  assert.ok(second.prompt.endsWith('edit routes'), 'the original prompt must survive');
  assert.ok(!first.prompt.includes('CONFLICT'), 'the first dispatch should not be annotated');
});

test('non-overlapping claims are not flagged', () => {
  resetBoards();
  const s = settings();
  const second = {
    subagent_type: 'implementer',
    description: 'Docs',
    prompt: '<!-- superagent-ownership: write=docs/** -->\nwrite docs',
  };
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'API', prompt: '<!-- superagent-ownership: write=src/api/** -->' }, s);
  onDispatch('root', 'c2', second, s);
  assert.ok(!second.prompt.includes('CONFLICT'));
});

test('a completed dispatch no longer conflicts with a new one', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'API', prompt: '<!-- superagent-ownership: write=src/api/** -->' }, s);
  onDispatchResult('root', 'c1', { output: 'done' }, s);

  const second = { subagent_type: 'implementer', description: 'More API', prompt: '<!-- superagent-ownership: write=src/api/** -->\ngo' };
  onDispatch('root', 'c2', second, s);
  assert.ok(!second.prompt.includes('CONFLICT'), 'a finished dispatch still owns its files');
});

test('the board flags running dispatches that declared no ownership', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'T', prompt: 'no marker' }, s);
  assert.match(renderBoard('root'), /declared no file ownership/);
});

test('boards are per session', () => {
  resetBoards();
  const s = settings();
  onDispatch('root-a', 'c1', { subagent_type: 'implementer', description: 'A' }, s);
  assert.match(renderBoard('root-a'), /\| A \|/);
  assert.equal(renderBoard('root-b'), null);
});

test('the board is disabled by config', () => {
  resetBoards();
  const s = settings();
  s.board.enabled = false;
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'T' }, s);
  assert.equal(renderBoard('root'), null);
});

// ------------------------------------------------------------- injection

test('nothing is injected when no dispatch has happened', () => {
  resetBoards();
  const messages = [userMessage('root')];
  assert.equal(injectBoard(messages, settings()), false);
  assert.equal(messages[0].parts.length, 1);
});

test('the latest strategy leaves exactly one snapshot after repeated transforms', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'T' }, s);

  const messages = [userMessage('root')];
  injectBoard(messages, s);
  injectBoard(messages, s);
  injectBoard(messages, s);

  const snapshots = messages.flatMap((m) => m.parts).filter((p) => p.text?.startsWith(BOARD_MARKER));
  assert.equal(snapshots.length, 1, 'stale snapshots accumulated in history');
});

test('the latest strategy replaces a stale snapshot rather than appending', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'T' }, s);

  const messages = [userMessage('root')];
  injectBoard(messages, s);
  onDispatchResult('root', 'c1', { output: 'finished' }, s);
  injectBoard(messages, s);

  const snapshot = messages[0].parts.find((p) => p.text?.startsWith(BOARD_MARKER)).text;
  assert.match(snapshot, /completed/);
  assert.ok(!snapshot.includes('| running |'), 'the stale state is still in context');
});

test('the snapshot goes on the last user message, not the first', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'T' }, s);

  const messages = [userMessage('root', 'first'), { info: { role: 'assistant', sessionID: 'root' }, parts: [] }, userMessage('root', 'latest')];
  injectBoard(messages, s);

  assert.ok(!messages[0].parts.some((p) => p.text?.startsWith(BOARD_MARKER)));
  assert.ok(messages[2].parts.some((p) => p.text?.startsWith(BOARD_MARKER)));
});

test('a session with no board of its own gets no snapshot', () => {
  resetBoards();
  const s = settings();
  onDispatch('root-a', 'c1', { subagent_type: 'implementer', description: 'T' }, s);
  const messages = [userMessage('root-b')];
  assert.equal(injectBoard(messages, s), false);
});

test('injection tolerates malformed message arrays', () => {
  resetBoards();
  const s = settings();
  assert.equal(injectBoard(null, s), false);
  assert.equal(injectBoard([], s), false);
  assert.equal(injectBoard([{ info: {} }], s), false);
});

// ------------------------------------------------------------- tui snapshot

test('boardSnapshots projects the ledger as plain data for the panel', () => {
  resetBoards();
  const s = settings();
  onDispatch(
    'root',
    'c1',
    {
      subagent_type: 'implementer',
      description: 'Add the tests',
      background: true,
      prompt: 'work\n<!-- superagent-ownership: write=src/api/** -->\n',
    },
    s
  );

  const snapshots = boardSnapshots();
  assert.deepEqual(Object.keys(snapshots), ['root']);
  assert.deepEqual(snapshots.root.records, [
    {
      agent: 'implementer',
      objective: 'Add the tests',
      state: 'running',
      background: true,
      owns: ['src/api/**'],
      startedAt: snapshots.root.records[0].startedAt,
    },
  ]);
  assert.equal(typeof snapshots.root.updatedAt, 'number');
});

test('boardSnapshots and the rendered board agree about state', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'oracle', description: 'Ask' }, s);
  onDispatchResult('root', 'c1', { output: 'answered' }, s);

  const record = boardSnapshots().root.records[0];
  assert.equal(record.state, 'completed');
  assert.ok(record.endedAt >= record.startedAt);
  assert.match(renderBoard('root'), /completed/);
});

test('boardSnapshots covers every session, since the panel picks one later', () => {
  resetBoards();
  const s = settings();
  onDispatch('root-a', 'c1', { subagent_type: 'implementer', description: 'A' }, s);
  onDispatch('root-b', 'c2', { subagent_type: 'librarian', description: 'B' }, s);

  assert.deepEqual(Object.keys(boardSnapshots()).sort(), ['root-a', 'root-b']);
});

test('a deleted session leaves the snapshot, as it leaves the board', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'A' }, s);
  onSessionEvent('session.deleted', 'root');

  assert.deepEqual(boardSnapshots(), {});
});

test('an unchanged board reports the same updatedAt, so the panel is not woken', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'A' }, s);

  const first = JSON.stringify(boardSnapshots());
  assert.equal(JSON.stringify(boardSnapshots()), first, 'a wall clock leaked into the projection');
});

test('onSessionEvent reports whether it changed anything', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { subagent_type: 'implementer', description: 'A' }, s);
  onDispatchResult('root', 'c1', { metadata: { background: true, jobId: 'child' } }, s);

  assert.equal(onSessionEvent('message.updated', 'child'), false, 'not a lifecycle event');
  assert.equal(onSessionEvent('session.idle', 'unknown-child'), false, 'nobody was waiting on it');
  assert.equal(onSessionEvent('session.idle', 'child'), true);
  assert.equal(onSessionEvent('session.idle', 'child'), false, 'it had already settled');
});
