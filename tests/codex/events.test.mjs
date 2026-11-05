import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSettings } from '../../core/config.js';
import { createAdapter } from '../../codex/lib/adapter.js';
import { handleEvent } from '../../codex/lib/events.js';
const settings = resolveSettings();
const adapter = createAdapter(settings);
const event = (name, extra = {}) => ({
  hook_event_name: name,
  session_id: 'root',
  cwd: '/repo',
  ...extra,
});
const state = () => ({ boards: {}, sessions: {}, activity: {} });

test('hook lifecycle restores board state, links children and injects completion', () => {
  const s = state();
  const first = handleEvent(event('SessionStart'), s, settings, adapter);
  assert.match(first.hookSpecificOutput.additionalContext, /SUPERAGENT_ROUTING/);
  const input = {
    agent_type: 'superagent-implementer',
    message: 'Task one\n<!-- superagent-ownership: write=src/** -->',
  };
  handleEvent(
    event('PreToolUse', { tool_name: 'spawn_agent', tool_use_id: 'call', tool_input: input }),
    s,
    settings,
    adapter,
  );
  handleEvent(
    event('PostToolUse', {
      tool_name: 'spawn_agent',
      tool_use_id: 'call',
      tool_response: { agent_id: 'child' },
    }),
    s,
    settings,
    adapter,
  );
  assert.equal(s.boards.root[0].state, 'running');
  const conflict = handleEvent(
    event('PreToolUse', { tool_name: 'spawn_agent', tool_use_id: 'other', tool_input: input }),
    s,
    settings,
    adapter,
  );
  assert.match(conflict.hookSpecificOutput.updatedInput.message, /conflict/i);
  handleEvent(
    event('SubagentStop', { agent_id: 'child', last_assistant_message: 'DONE' }),
    s,
    settings,
    adapter,
  );
  assert.equal(s.boards.root[0].state, 'completed');
  const prompt = handleEvent(event('UserPromptSubmit'), s, settings, adapter);
  assert.match(prompt.hookSpecificOutput.additionalContext, /completed/);
  assert.equal(s.boards.root[0].result, 'DONE');
});

test('guard denies worker dispatch and reviewer patches without auto-approving allowed tools', () => {
  const s = state();
  const deny = handleEvent(
    event('PreToolUse', {
      agent_type: 'superagent-implementer',
      tool_name: 'spawn_agent',
      tool_input: {},
    }),
    s,
    settings,
    adapter,
  );
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  const patch = handleEvent(
    event('PreToolUse', {
      agent_type: 'superagent-task-reviewer',
      tool_name: 'apply_patch',
      tool_input: '*** Begin Patch\n*** Add File: src/x\n+x\n*** End Patch',
    }),
    s,
    settings,
    adapter,
  );
  assert.equal(patch.hookSpecificOutput.permissionDecision, 'deny');
  const allow = handleEvent(
    event('PreToolUse', {
      agent_type: 'superagent-implementer',
      tool_name: 'apply_patch',
      tool_input: '*** Begin Patch\n*** Add File: src/x\n+x\n*** End Patch',
    }),
    s,
    settings,
    adapter,
  );
  assert.equal(allow.hookSpecificOutput, undefined);
});

test('native default controller is guarded and bootstrap is not duplicated each prompt', () => {
  const s = state();
  const first = handleEvent(event('SessionStart', { agent_type: 'default' }), s, settings, adapter);
  assert.match(first.hookSpecificOutput.additionalContext, /SUPERAGENT_ROUTING/);
  const next = handleEvent(
    event('UserPromptSubmit', { agent_type: 'default' }),
    s,
    settings,
    adapter,
  );
  assert.equal(next.hookSpecificOutput, undefined);
  const deny = handleEvent(
    event('PreToolUse', {
      agent_type: 'default',
      tool_name: 'apply_patch',
      tool_input: '*** Begin Patch\n*** Add File: src/x\n+x\n*** End Patch',
    }),
    s,
    settings,
    adapter,
  );
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  const compact = handleEvent(
    event('PostCompact', { agent_type: 'default' }),
    s,
    settings,
    adapter,
  );
  assert.match(compact.hookSpecificOutput.additionalContext, /SUPERAGENT_ROUTING/);
});
