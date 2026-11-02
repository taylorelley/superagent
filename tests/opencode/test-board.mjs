/**
 * Unit tests for the job board and ownership checking.
 *
 * These drive the plugin's hooks with synthetic payloads shaped like the ones
 * OpenCode V2 sends — `subagent` tool input, `execute.after` outcomes, the
 * `context` hook's `{ role, content }` messages — so they need no binary.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOwnership, globsOverlap, findConflicts } from '../../.opencode/lib/ownership.js';
import {
  onDispatch,
  onDispatchResult,
  onSessionEvent,
  onChildCreated,
  renderBoard,
  injectBoard,
  boardSnapshots,
  backgroundSessionID,
  unwrapSubagent,
  resetBoards,
  BOARD_MARKER,
} from '../../.opencode/lib/board.js';
import { loadConfig } from '../../.opencode/lib/config-schema.js';

const settings = () => loadConfig({ env: {} });

// The session a request is for comes from the hook event in V2, not the
// messages, so the first argument is only there to keep call sites readable.
const userMessage = (_sessionID, text = 'hello') => ({
  role: 'user',
  content: [{ type: 'text', text }],
});

/** A foreground `subagent` call that finished with `text`. */
const done = (text) => ({ status: 'completed', result: { content: [{ type: 'text', text }] } });

/** A background `subagent` call, as the V2 tool reports it. */
const launched = (sessionID) =>
  done(
    `The subagent is working in the background (sessionID: ${sessionID}). You will be notified automatically when it finishes.`,
  );

const isSnapshot = (p) => p.text?.trimStart().startsWith(BOARD_MARKER);

// ------------------------------------------------------------- ownership

test('parseOwnership reads a declaration, and distinguishes absent from empty', () => {
  assert.equal(parseOwnership('no marker here'), null, 'absent must be distinguishable');
  assert.deepEqual(
    parseOwnership(
      'do work\n<!-- superagent-ownership: write=src/api/**,src/db/**; read=src/** -->\n',
    ),
    { write: ['src/api/**', 'src/db/**'], read: ['src/**'] },
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
    {
      id: 'a',
      agent: 'implementer',
      objective: 'api',
      ownership: { write: ['src/api/**'], read: [] },
    },
    {
      id: 'b',
      agent: 'implementer',
      objective: 'docs',
      ownership: { write: ['docs/**'], read: [] },
    },
  ];
  assert.deepEqual(
    findConflicts({ write: ['src/api/routes.ts'] }, running).map((r) => r.id),
    ['a'],
  );
  assert.deepEqual(findConflicts({ write: ['test/**'] }, running), []);
  // A read-only dispatch cannot collide with anyone.
  assert.deepEqual(findConflicts({ write: [], read: ['src/**'] }, running), []);
});

// ----------------------------------------------------------------- board

test('a foreground dispatch is recorded and completed', () => {
  resetBoards();
  const s = settings();
  const args = { agent: 'implementer', description: 'Task 1', prompt: 'do it' };

  onDispatch('root', 'call-1', args, s);
  assert.match(renderBoard('root'), /implementer \| Task 1 \| running/);

  onDispatchResult('root', 'call-1', done('done, all tests pass'), s);
  const board = renderBoard('root');
  assert.match(board, /implementer \| Task 1 \| completed/);
  assert.match(board, /0 still running/);
});

test('a background dispatch stays running until its session ends', () => {
  resetBoards();
  const s = settings();
  onDispatch(
    'root',
    'call-1',
    { agent: 'implementer', description: 'Task 1', background: true },
    s,
  );

  // The tool returns as soon as the job launches — that is not completion.
  onDispatchResult('root', 'call-1', launched('child-9'), s);
  assert.match(renderBoard('root'), /running \(bg\)/);

  onSessionEvent('session.execution.succeeded', 'child-9');
  assert.match(renderBoard('root'), /completed/);
});

test('a failed background dispatch is recorded as an error, not a completion', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T', background: true }, s);
  onDispatchResult('root', 'c1', launched('child-1'), s);
  onSessionEvent('session.execution.failed', 'child-1');
  assert.match(renderBoard('root'), /\| error \(bg\) \|/);
});

test('an unrelated session event does not touch the board', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T', background: true }, s);
  onDispatchResult('root', 'c1', launched('child-1'), s);
  onSessionEvent('session.execution.succeeded', 'some-other-session');
  assert.match(renderBoard('root'), /running/);
});

test('conflicting write claims annotate the second dispatch', () => {
  resetBoards();
  const s = settings();
  const first = {
    agent: 'implementer',
    description: 'API',
    prompt: '<!-- superagent-ownership: write=src/api/** -->\nbuild the api',
  };
  const second = {
    agent: 'implementer',
    description: 'Routes',
    prompt: '<!-- superagent-ownership: write=src/api/routes.ts -->\nedit routes',
  };

  onDispatch('root', 'c1', first, s);
  onDispatch('root', 'c2', second, s);

  assert.match(second.prompt, /SUPERAGENT_OWNERSHIP_CONFLICT/, 'second dispatch was not warned');
  assert.match(
    second.prompt,
    /src\/api\/\*\*/,
    'conflict notice should name the conflicting claim',
  );
  assert.ok(second.prompt.endsWith('edit routes'), 'the original prompt must survive');
  assert.ok(!first.prompt.includes('CONFLICT'), 'the first dispatch should not be annotated');
});

test('non-overlapping claims are not flagged', () => {
  resetBoards();
  const s = settings();
  const second = {
    agent: 'implementer',
    description: 'Docs',
    prompt: '<!-- superagent-ownership: write=docs/** -->\nwrite docs',
  };
  onDispatch(
    'root',
    'c1',
    {
      agent: 'implementer',
      description: 'API',
      prompt: '<!-- superagent-ownership: write=src/api/** -->',
    },
    s,
  );
  onDispatch('root', 'c2', second, s);
  assert.ok(!second.prompt.includes('CONFLICT'));
});

test('a completed dispatch no longer conflicts with a new one', () => {
  resetBoards();
  const s = settings();
  onDispatch(
    'root',
    'c1',
    {
      agent: 'implementer',
      description: 'API',
      prompt: '<!-- superagent-ownership: write=src/api/** -->',
    },
    s,
  );
  onDispatchResult('root', 'c1', done('done'), s);

  const second = {
    agent: 'implementer',
    description: 'More API',
    prompt: '<!-- superagent-ownership: write=src/api/** -->\ngo',
  };
  onDispatch('root', 'c2', second, s);
  assert.ok(!second.prompt.includes('CONFLICT'), 'a finished dispatch still owns its files');
});

test('the board flags running dispatches that declared no ownership', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T', prompt: 'no marker' }, s);
  assert.match(renderBoard('root'), /declared no file ownership/);
});

test('boards are per session', () => {
  resetBoards();
  const s = settings();
  onDispatch('root-a', 'c1', { agent: 'implementer', description: 'A' }, s);
  assert.match(renderBoard('root-a'), /\| A \|/);
  assert.equal(renderBoard('root-b'), null);
});

test('the board is disabled by config', () => {
  resetBoards();
  const s = settings();
  s.board.enabled = false;
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T' }, s);
  assert.equal(renderBoard('root'), null);
});

// ------------------------------------------------------------- injection

test('nothing is injected when no dispatch has happened', () => {
  resetBoards();
  const messages = [userMessage('root')];
  assert.equal(injectBoard(messages, 'root', settings()), false);
  assert.equal(messages[0].content.length, 1);
});

test('the latest strategy leaves exactly one snapshot after repeated transforms', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T' }, s);

  const messages = [userMessage('root')];
  injectBoard(messages, 'root', s);
  injectBoard(messages, 'root', s);
  injectBoard(messages, 'root', s);

  const snapshots = messages.flatMap((m) => m.content).filter((p) => isSnapshot(p));
  assert.equal(snapshots.length, 1, 'stale snapshots accumulated in history');
});

test('the latest strategy replaces a stale snapshot rather than appending', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T' }, s);

  const messages = [userMessage('root')];
  injectBoard(messages, 'root', s);
  onDispatchResult('root', 'c1', done('finished'), s);
  injectBoard(messages, 'root', s);

  const snapshot = messages[0].content.find((p) => isSnapshot(p)).text;
  assert.match(snapshot, /completed/);
  assert.ok(!snapshot.includes('| running |'), 'the stale state is still in context');
});

test('the snapshot goes on the last user message, not the first', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T' }, s);

  const messages = [
    userMessage('root', 'first'),
    { role: 'assistant', content: [] },
    userMessage('root', 'latest'),
  ];
  injectBoard(messages, 'root', s);

  assert.ok(!messages[0].content.some((p) => isSnapshot(p)));
  assert.ok(messages[2].content.some((p) => isSnapshot(p)));
});

test('a session with no board of its own gets no snapshot', () => {
  resetBoards();
  const s = settings();
  onDispatch('root-a', 'c1', { agent: 'implementer', description: 'T' }, s);
  const messages = [userMessage('root-b')];
  assert.equal(injectBoard(messages, 'root-b', s), false);
});

test('injection tolerates malformed message arrays', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T' }, s);
  assert.equal(injectBoard(null, 'root', s), false);
  assert.equal(injectBoard([], 'root', s), false);
  assert.equal(injectBoard([{ role: 'user' }], 'root', s), false);
  assert.equal(injectBoard([userMessage('root')], undefined, s), false, 'no session, no board');
});

// ------------------------------------------------------------- tui snapshot

test('boardSnapshots projects the ledger as plain data for the panel', () => {
  resetBoards();
  const s = settings();
  onDispatch(
    'root',
    'c1',
    {
      agent: 'implementer',
      description: 'Add the tests',
      background: true,
      prompt: 'work\n<!-- superagent-ownership: write=src/api/** -->\n',
    },
    s,
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
  onDispatch('root', 'c1', { agent: 'oracle', description: 'Ask' }, s);
  onDispatchResult('root', 'c1', done('answered'), s);

  const record = boardSnapshots().root.records[0];
  assert.equal(record.state, 'completed');
  assert.ok(record.endedAt >= record.startedAt);
  assert.match(renderBoard('root'), /completed/);
});

test('boardSnapshots covers every session, since the panel picks one later', () => {
  resetBoards();
  const s = settings();
  onDispatch('root-a', 'c1', { agent: 'implementer', description: 'A' }, s);
  onDispatch('root-b', 'c2', { agent: 'librarian', description: 'B' }, s);

  assert.deepEqual(Object.keys(boardSnapshots()).sort(), ['root-a', 'root-b']);
});

test('a deleted session leaves the snapshot, as it leaves the board', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'A' }, s);
  onSessionEvent('session.deleted', 'root');

  assert.deepEqual(boardSnapshots(), {});
});

test('an unchanged board reports the same updatedAt, so the panel is not woken', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'A' }, s);

  const first = JSON.stringify(boardSnapshots());
  assert.equal(JSON.stringify(boardSnapshots()), first, 'a wall clock leaked into the projection');
});

test('onSessionEvent reports whether it changed anything', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'A', background: true }, s);
  onDispatchResult('root', 'c1', launched('child'), s);

  assert.equal(onSessionEvent('message.updated', 'child'), false, 'not a lifecycle event');
  assert.equal(
    onSessionEvent('session.execution.succeeded', 'unknown-child'),
    false,
    'nobody was waiting on it',
  );
  assert.equal(onSessionEvent('session.execution.succeeded', 'child'), true);
  assert.equal(
    onSessionEvent('session.execution.succeeded', 'child'),
    false,
    'it had already settled',
  );
});

// ------------------------------------------------------------- V2 shapes

test('a failed subagent call is recorded as an error with its message', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T' }, s);
  onDispatchResult('root', 'c1', { status: 'error', error: { message: 'Unknown agent: x' } }, s);
  assert.match(renderBoard('root'), /\| error \|/);
});

test('the background child session is found in metadata, text, or the input', () => {
  assert.equal(backgroundSessionID({ metadata: { sessionID: 'm' } }), 'm');
  assert.equal(backgroundSessionID(launched('t').result), 't');
  assert.equal(backgroundSessionID({ content: [] }, { sessionID: 'continued' }), 'continued');
  assert.equal(backgroundSessionID({ content: [] }), undefined);
});

test('a background call with no child id to wait on is not left running forever', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T', background: true }, s);
  onDispatchResult('root', 'c1', done('started'), s);
  assert.match(renderBoard('root'), /\| completed \(bg\) \|/);
});

test('an interrupted or deleted child settles as cancelled', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'implementer', description: 'T', background: true }, s);
  onDispatchResult('root', 'c1', launched('child'), s);
  assert.equal(onSessionEvent('session.execution.interrupted', 'child'), true);
  assert.match(renderBoard('root'), /\| cancelled \(bg\) \|/);
});

// ------------------------------------------------- panel-facing projections

test('the snapshot carries what came back, one line long', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'explore', description: 'Find callers', prompt: 'p' }, s);
  onDispatchResult('root', 'c1', done(`Found 3 call sites ${'x'.repeat(300)}`), s);
  onDispatch('root', 'c2', { agent: 'implementer', description: 'Break', prompt: 'p' }, s);
  onDispatchResult('root', 'c2', { status: 'error', error: { message: 'npm test exited 1' } }, s);

  const [ok, bad] = boardSnapshots().root.records;
  assert.ok(ok.result.startsWith('Found 3 call sites'));
  assert.ok(ok.result.length <= 121, 'the result is truncated for a one-line slot');
  assert.equal(bad.result, 'npm test exited 1');
});

test('the snapshot names who a conflicting dispatch overlapped', () => {
  resetBoards();
  const s = settings();
  onDispatch(
    'root',
    'c1',
    {
      agent: 'implementer',
      description: 'API',
      prompt: '<!-- superagent-ownership: write=src/api/** -->',
    },
    s,
  );
  onDispatch(
    'root',
    'c2',
    {
      agent: 'reviewer',
      description: 'Fix',
      prompt: '<!-- superagent-ownership: write=src/api/a.ts -->',
    },
    s,
  );
  const [first, second] = boardSnapshots().root.records;
  assert.equal(first.conflicts, undefined);
  assert.deepEqual(second.conflicts, ['implementer']);
});

test('a foreground child session is linked to its dispatch by agent and title', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'general', description: 'Count files', prompt: 'p' }, s);
  onDispatch('root', 'c2', { agent: 'general', description: 'Other', prompt: 'p' }, s);

  assert.equal(onChildCreated('root', 'ses_child', 'general', 'Count files', s), true);
  const records = boardSnapshots().root.records;
  assert.equal(records[0].childSessionID, 'ses_child');
  assert.equal(records[1].childSessionID, undefined);
});

test('a linked foreground child settles its record when it finishes', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'general', description: 'Count files', prompt: 'p' }, s);
  onChildCreated('root', 'ses_child', 'general', 'Count files', s);
  assert.equal(onSessionEvent('session.execution.succeeded', 'ses_child'), true);
  onDispatchResult('root', 'c1', done('Found 1 file'), s);
  const [record] = boardSnapshots().root.records;
  assert.equal(record.state, 'completed');
  assert.equal(record.result, 'Found 1 file');
});

test('a child session with no matching dispatch links nothing', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'general', description: 'A', prompt: 'p' }, s);
  onDispatch('root', 'c2', { agent: 'general', description: 'B', prompt: 'p' }, s);
  assert.equal(onChildCreated('root', 'ses_x', 'general', 'C', s), false, 'ambiguous: no guess');
  assert.equal(onChildCreated('other', 'ses_x', 'general', 'A', s), false);
  assert.equal(onChildCreated(undefined, 'ses_x', 'general', 'A', s), false);
  assert.equal(onChildCreated('root', 'ses_y', 'explore', 'A', s), false, 'wrong agent');
});

test('a subagent result is shown without the envelope OpenCode wraps it in', () => {
  const wrapped =
    '<subagent sessionID="ses_1" state="completed">\nFound 1 file: README.md\n</subagent>';
  assert.equal(unwrapSubagent(wrapped), 'Found 1 file: README.md');
  assert.equal(unwrapSubagent('plain text'), 'plain text');
  assert.equal(unwrapSubagent(undefined), '');

  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'general', description: 'Count', prompt: 'p' }, s);
  onDispatchResult('root', 'c1', done(wrapped), s);
  assert.equal(boardSnapshots().root.records[0].result, 'Found 1 file: README.md');
});

test('a follow-up dispatch to an existing subagent is linked to that child', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'general', description: 'First', prompt: 'p' }, s);
  onChildCreated('root', 'ses_child', 'general', 'First', s);
  onDispatchResult('root', 'c1', done('ok'), s);
  // Resuming names the child; OpenCode sends no session.created for it.
  onDispatch(
    'root',
    'c2',
    { agent: 'general', description: 'Now test', prompt: 'p', sessionID: 'ses_child' },
    s,
  );
  const [first, second] = boardSnapshots().root.records;
  assert.equal(first.state, 'completed');
  assert.equal(second.state, 'running');
  assert.equal(second.childSessionID, 'ses_child');
});

test('a lone running dispatch does not claim a child with a different title', () => {
  resetBoards();
  const s = settings();
  onDispatch('root', 'c1', { agent: 'general', description: 'Count files', prompt: 'p' }, s);
  assert.equal(onChildCreated('root', 'ses_other', 'general', 'Unrelated work', s), false);
  assert.equal(boardSnapshots().root.records[0].childSessionID, undefined);
});
