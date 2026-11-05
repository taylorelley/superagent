import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expandCommand } from '../../codex/lib/commands.js';
import { createAdapter } from '../../codex/lib/adapter.js';
import { renderTextPanel } from '../../codex/lib/panel.js';
import { resolveSettings } from '../../core/config.js';

test('preset persistence and council use shared semantics and Codex dispatch syntax', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'superagent-command-'));
  try {
    const settings = resolveSettings({
      userFile: {
        preset: 'council',
        council: {
          members: [
            { name: 'a', model: 'mock/a' },
            { name: 'b', model: 'mock/b' },
          ],
        },
      },
    });
    const adapter = createAdapter(settings);
    const state = { boards: {}, sessions: {}, activity: {} };
    const context = { settings, adapter, state, sessionID: 'root', configDir: dir };
    const council = await expandCommand('council', 'Which design?', context);
    assert.match(council, /spawn_agent/);
    assert.match(council, /agent_type/);
    assert.match(council, /Which design/);
    assert.match(await expandCommand('preset', 'solo --persist', context), /new Codex session/);
    assert.equal(
      JSON.parse(await fs.readFile(path.join(dir, 'superagent.state.json'), 'utf8')).preset,
      'solo',
    );
    assert.equal(state.sessions.root.preset, 'solo');
    assert.match(await expandCommand('preset', 'unknown', context), /Unknown preset/);
    assert.equal(await expandCommand('missing', '', context), null);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('panel renders the shared roster and live dispatch details', () => {
  const settings = resolveSettings();
  const adapter = createAdapter(settings);
  const state = {
    sessions: {},
    activity: { root: { tool: 'exec_command npm test', startedAt: 100 } },
    boards: {
      root: [
        {
          id: 'call',
          agent: 'superagent-implementer',
          objective: 'Task 1',
          state: 'running',
          startedAt: 100,
          ownership: { write: ['src/**'], read: [] },
          background: true,
        },
      ],
    },
  };
  const text = renderTextPanel({ state, sessionID: 'root', settings, adapter, now: 1100 });
  assert.match(text, /Superagent/);
  assert.match(text, /Task 1/);
  assert.match(text, /src\/\*\*/);
  assert.match(text, /exec_command/);
});
