import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../../codex/lib/config.js';
import { buildRoster, toCodexModel } from '../../codex/lib/roster.js';
import { checkTool } from '../../codex/lib/permissions.js';
import { resolveSettings } from '../../core/config.js';
import { ROSTER } from '../../core/roster.js';

const root = path.resolve(import.meta.dirname, '../..');
const settings = resolveSettings();
const prompts = Object.fromEntries(
  ROSTER.map(({ prompt }) => {
    const file = prompt.kind === 'template' ? prompt.path : `.opencode/${prompt.path}`;
    return [file, fs.readFileSync(path.join(root, file), 'utf8')];
  }),
);

test('all shared roles retain their composed prompts and permission rules', () => {
  const roster = buildRoster(settings, prompts);
  assert.equal(roster.registered.length, 10);
  assert.equal(roster.specialists.length, 9);
  assert.match(roster.orchestrator.prompt, /orchestrat/i);
  assert.match(roster.specialists[0].prompt, /SUPERAGENT_CONTRACT/);
  assert.equal(roster.warnings.length, 0);
});

test('disabled and colliding roles are not advertised', () => {
  const custom = resolveSettings({ projectFile: { agents: { disable: ['oracle'] } } });
  const result = buildRoster(custom, prompts, new Set(['superagent-implementer']));
  assert.equal(
    result.registered.some((r) => r.key === 'oracle'),
    false,
  );
  assert.equal(
    result.registered.some((r) => r.key === 'implementer'),
    false,
  );
  assert.equal(
    buildRoster(resolveSettings({ projectFile: { preset: 'solo' } }), prompts).registered.length,
    0,
  );
});

test('Codex models preserve provider routing and separate reasoning effort', () => {
  assert.deepEqual(toCodexModel(null), {});
  assert.deepEqual(toCodexModel('openai/gpt-test#high'), {
    model: 'gpt-test',
    model_provider: 'openai',
    model_reasoning_effort: 'high',
  });
  assert.ok(toCodexModel('gpt-test#invented').warning);
});

test('role guards enforce normalized dispatch, patch paths and ask overrides', () => {
  const roster = buildRoster(settings, prompts);
  const worker = roster.specialists.find((r) => r.key === 'implementer');
  assert.equal(checkTool(worker.rules, 'functions.spawn_agent', {}, '/repo').effect, 'deny');
  const reviewer = roster.specialists.find((r) => r.key === 'task-reviewer');
  assert.equal(
    checkTool(
      reviewer.rules,
      'apply_patch',
      '*** Begin Patch\n*** Add File: a\n+x\n*** End Patch',
      '/repo',
    ).effect,
    'deny',
  );
  const controller = roster.orchestrator;
  assert.equal(
    checkTool(
      controller.rules,
      'apply_patch',
      '*** Begin Patch\n*** Add File: .superagent/spec.md\n+x\n*** End Patch',
      '/repo',
    ).effect,
    'allow',
  );
  assert.equal(
    checkTool(
      controller.rules,
      'apply_patch',
      '*** Begin Patch\n*** Add File: .superagent/../src/a\n+x\n*** End Patch',
      '/repo',
    ).effect,
    'deny',
  );
  assert.equal(checkTool(controller.rules, 'apply_patch', 'unparseable', '/repo').effect, 'deny');
  assert.equal(
    checkTool(
      [{ action: 'shell', resource: '*', effect: 'ask' }],
      'exec_command',
      { cmd: 'echo ok' },
      '/repo',
    ).effect,
    'ask',
  );
});

test('config uses Codex directories, JSONC and existing shared precedence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-config-'));
  try {
    fs.mkdirSync(path.join(dir, '.codex'));
    fs.writeFileSync(path.join(dir, 'superagent.jsonc'), '{"preset":"solo", // user\n}');
    fs.writeFileSync(path.join(dir, '.codex/superagent.json'), '{"preset":"council"}');
    assert.equal(loadConfig({ configDir: dir, projectDir: dir, env: {} }).preset, 'council');
    fs.writeFileSync(path.join(dir, 'superagent.state.json'), '{"preset":"team"}');
    assert.equal(
      loadConfig({ configDir: dir, projectDir: dir, env: { SUPERAGENT_PRESET: 'solo' } }).preset,
      'solo',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('role-name truncation and council aliases cannot create duplicate identities', () => {
  const prefixed = resolveSettings({ projectFile: { agents: { prefix: 'x'.repeat(80) } } });
  const roster = buildRoster(prefixed, prompts);
  assert.equal(new Set(roster.registered.map((r) => r.name)).size, roster.registered.length);
  assert.ok(roster.warnings.length > 0);
  const council = resolveSettings({
    projectFile: {
      preset: 'council',
      council: {
        members: [
          { name: 'a', model: 'gpt-test#high' },
          { name: 'b', model: 'openai/gpt-test#low' },
        ],
      },
    },
  });
  assert.equal(
    buildRoster(council, prompts).specialists.filter((r) => r.key.startsWith('councillor-')).length,
    1,
  );
  assert.ok(toCodexModel('openai/').warning);
  assert.deepEqual(toCodexModel('inherit#high'), { model_reasoning_effort: 'high' });
});

test('observed plan progress is limited to referenced workspace files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-plan-'));
  try {
    const plan = path.join(dir, 'docs/superagent/plans/example.md');
    fs.mkdirSync(path.dirname(plan), { recursive: true });
    fs.writeFileSync(plan, '## Task 1\n- [x] done\n## Task 2\n- [ ] remaining\n');
    return import('../../codex/lib/adapter.js')
      .then(({ observePlan }) => {
        const observed = observePlan({
          cwd: dir,
          tool_input: { cmd: 'cat docs/superagent/plans/example.md' },
        });
        assert.equal(observed.done, 1);
        assert.equal(observed.total, 2);
        assert.match(observed.current, /Task 2/);
        assert.equal(observePlan({ cwd: dir, tool_input: { cmd: 'cat /etc/passwd' } }), null);
      })
      .finally(() => fs.rmSync(dir, { recursive: true, force: true }));
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
});

test('scoped edit guards cannot follow a workspace symlink outside the allowed directory', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-path-'));
  try {
    fs.mkdirSync(path.join(dir, '.superagent'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.symlinkSync(path.join(dir, 'src'), path.join(dir, '.superagent', 'linked'), 'junction');
    const controller = buildRoster(settings, prompts).orchestrator;
    const patch =
      '*** Begin Patch\n*** Add File: .superagent/linked/source.js\n+changed\n*** End Patch';
    assert.equal(checkTool(controller.rules, 'apply_patch', patch, dir).effect, 'deny');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Codex compatibility hook names preserve native shell and edit guard semantics', () => {
  const deny = [{ action: 'shell', resource: 'touch *', effect: 'deny' }];
  assert.equal(checkTool(deny, 'Bash', { command: 'touch marker' }, '/repo').effect, 'deny');
  const reviewer = buildRoster(settings, prompts).specialists.find(
    (r) => r.key === 'task-reviewer',
  );
  assert.equal(
    checkTool(reviewer.rules, 'Write', { file_path: '/repo/file.js' }, '/repo').effect,
    'deny',
  );
  assert.equal(checkTool(reviewer.rules, 'Agent', {}, '/repo').effect, 'deny');
});
