import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { withState, readState } from '../../codex/lib/state.js';
import * as board from '../../core/board.js';
import { resolveSettings } from '../../core/config.js';

test('concurrent transactions retain every update and reject corrupt checkpoints', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'superagent-state-'));
  const file = path.join(dir, 'state.json');
  try {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        withState(file, (s) => {
          s.sessions[i] = { preset: 'team' };
        }),
      ),
    );
    assert.equal(Object.keys((await readState(file)).sessions).length, 12);
    await fs.writeFile(file, '{invalid');
    await assert.rejects(withState(file, () => {}));
    assert.equal(await fs.readFile(file, 'utf8'), '{invalid');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('board checkpoints retain ids, ownership and child links across hook processes', () => {
  board.resetBoards();
  const settings = resolveSettings();
  board.onDispatch(
    'root',
    'call',
    {
      agent: 'implementer',
      prompt: '<!-- superagent-ownership: write=src/** -->',
      background: true,
    },
    settings,
  );
  board.linkChild('root', 'call', 'child');
  const saved = JSON.parse(JSON.stringify(board.exportBoardState()));
  board.resetBoards();
  board.restoreBoardState(saved);
  assert.equal(board.exportBoardState().root[0].childSessionID, 'child');
  const args = { agent: 'implementer', prompt: '<!-- superagent-ownership: write=src/a -->' };
  board.onDispatch('root', 'other', args, settings);
  assert.match(args.prompt, /conflict/i);
  board.settleChild('child', 'completed', 'Done');
  assert.equal(board.exportBoardState().root[0].state, 'completed');
  assert.throws(() => board.restoreBoardState({ root: [{}] }));
});

test('child session links resolve to the same durable controller state', async () => {
  const { linkSession, sessionScope, statePath } = await import('../../codex/lib/state.js');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'superagent-links-'));
  try {
    assert.equal(await sessionScope(dir, 'root'), 'root');
    await linkSession(dir, 'child', 'root');
    assert.equal(await sessionScope(dir, 'child'), 'root');
    assert.equal(statePath(dir, await sessionScope(dir, 'child')), statePath(dir, 'root'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
