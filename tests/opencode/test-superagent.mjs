/**
 * Unit tests for the Superagent layer.
 *
 * These drive the plugin's own modules directly, so they need no OpenCode
 * binary. What they cannot prove is that OpenCode honours what we register —
 * that needs the integration test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { stripJsonc, deepMerge } from '../../.opencode/lib/fs-utils.js';
import { loadConfig, readConfigFile } from '../../.opencode/lib/config-schema.js';
import {
  extractDispatchTemplate,
  extractDispatchTemplateFile,
  AGENT_CONTRACT,
} from '../../.opencode/lib/prompt-compose.js';
import { ROSTER } from '../../.opencode/lib/roster.js';
import { registerAgents, resetPromptCache, parseModelRef } from '../../.opencode/lib/agents.js';
import { renderRoutingTable, renderConflicts } from '../../.opencode/lib/routing.js';
import { toRules } from '../../.opencode/lib/permissions.js';
import { discoverSkills, registerSkills, watchSkills } from '../../.opencode/lib/skills.js';
import { defaultAgentConfigured } from '../../.opencode/lib/opencode-config.js';
import { makeAgentEditor, makeSkillEditor, makeContext } from './fake-v2-context.mjs';
import { packageRoot } from '../../.opencode/lib/paths.js';

const withTempDir = (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-test-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// --------------------------------------------------------------- JSONC

test('stripJsonc removes comments without touching string contents', () => {
  assert.equal(stripJsonc('{"a": 1} // trailing'), '{"a": 1} ');
  assert.equal(stripJsonc('{"a": 1 /* mid */ }'), '{"a": 1  }');
  // The case a naive regex stripper gets wrong.
  assert.equal(stripJsonc('{"url": "http://x/y"}'), '{"url": "http://x/y"}');
  assert.equal(stripJsonc('{"s": "/* not a comment */"}'), '{"s": "/* not a comment */"}');
  assert.equal(stripJsonc('{"s": "a \\" // b"}'), '{"s": "a \\" // b"}');
  assert.equal(stripJsonc('{"a": 1,}'), '{"a": 1}');
  assert.equal(stripJsonc('[1, 2, ]'), '[1, 2 ]');
});

test('deepMerge merges objects and replaces arrays', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3 } }), { a: { b: 1, c: 3 } });
  // A user listing council members means their list, not theirs appended.
  assert.deepEqual(deepMerge({ m: [1, 2, 3] }, { m: [9] }), { m: [9] });
  assert.deepEqual(deepMerge({ a: 1 }, { a: undefined }), { a: 1 });
});

// --------------------------------------------------------------- config

test('a malformed config file degrades to defaults instead of throwing', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'superagent.json'), '{ this is not json');
    // Must not throw: OpenCode swallows a config-hook throw, so throwing here
    // would leave the plugin silently inert with no agents.
    const settings = loadConfig({ configDir: dir, env: {} });
    assert.equal(settings.agents.enabled, true);
    assert.equal(settings.preset, 'team');
  });
});

test('config layers project over user over preset over defaults', () => {
  withTempDir((userDir) =>
    withTempDir((projectDir) => {
      fs.writeFileSync(
        path.join(userDir, 'superagent.json'),
        JSON.stringify({ agents: { models: { reviewer: 'user/model', oracle: 'user/oracle' } } }),
      );
      fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, '.opencode', 'superagent.json'),
        JSON.stringify({ agents: { models: { reviewer: 'project/model' } } }),
      );

      const settings = loadConfig({ configDir: userDir, projectDir, env: {} });
      assert.equal(settings.agents.models.reviewer, 'project/model', 'project wins over user');
      assert.equal(
        settings.agents.models.oracle,
        'user/oracle',
        'user survives where project is silent',
      );
      assert.equal(
        settings.agents.models.implementer,
        null,
        'defaults survive where both are silent',
      );
    }),
  );
});

test('environment overrides beat every file', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'superagent.json'), JSON.stringify({ preset: 'team' }));
    const settings = loadConfig({ configDir: dir, env: { SUPERAGENT_DISABLE: '1' } });
    assert.equal(settings.agents.enabled, false);
  });
});

test('JSONC config files are accepted', () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'superagent.json'),
      '{\n  // pick a preset\n  "preset": "solo",\n}',
    );
    assert.equal(loadConfig({ configDir: dir, env: {} }).preset, 'solo');
  });
});

test('an unknown preset falls back to the default', () => {
  assert.equal(loadConfig({ env: { SUPERAGENT_PRESET: 'nope' } }).preset, 'team');
});

test('an invalid enum value is clamped rather than propagated', () => {
  withTempDir((dir) => {
    fs.writeFileSync(
      path.join(dir, 'superagent.json'),
      JSON.stringify({ board: { strategy: 'wat' } }),
    );
    assert.equal(loadConfig({ configDir: dir, env: {} }).board.strategy, 'latest');
  });
});

test('readConfigFile returns null for an absent file', () => {
  assert.equal(readConfigFile('/nonexistent/superagent.json'), null);
});

// -------------------------------------------------------- prompt extraction

test('every roster template extracts to a usable agent prompt', () => {
  const templates = ROSTER.filter((entry) => entry.prompt.kind === 'template');
  assert.ok(templates.length >= 6, 'expected the roster to reuse the shipped dispatch templates');

  for (const entry of templates) {
    const filePath = path.join(packageRoot, entry.prompt.path);
    const prompt = extractDispatchTemplateFile(filePath);

    assert.ok(prompt.length > 200, `${entry.key}: extracted prompt is suspiciously short`);
    // The dispatch scaffolding must not survive into the system prompt.
    assert.ok(!prompt.includes('Subagent ('), `${entry.key}: leaked the dispatch header`);
    assert.ok(!prompt.includes('[MODEL'), `${entry.key}: leaked the model placeholder`);
    assert.ok(!prompt.startsWith('```'), `${entry.key}: leaked the code fence`);
    assert.ok(
      !prompt.includes('Use this template when dispatching'),
      `${entry.key}: leaked the prose wrapper`,
    );
    // Role framing must survive.
    assert.match(prompt, /^You are /, `${entry.key}: prompt does not open with role framing`);
  }
});

test('a template whose shape changed fails loudly rather than degrading', () => {
  // If upstream rewrites a prompt file, we want a test failure here rather than
  // an agent registered with a page of markdown about dispatching.
  assert.throws(
    () => extractDispatchTemplate('# Just a heading\n\nNo fence.', 'fake'),
    /no fenced block/,
  );
  assert.throws(
    () => extractDispatchTemplate('```\nSubagent (x):\n  prompt: |\n```', 'fake'),
    /empty/,
  );
});

// --------------------------------------------------------------- roster

/**
 * The effect a rule list gives `action` on resource `*` under V2's last-match
 * semantics, considering only rules whose resource is `*`.
 */
const effectFor = (agent, action) =>
  agent.permissions
    .filter((r) => (r.action === action || r.action === '*') && r.resource === '*')
    .at(-1)?.effect;

/** Roster agents (everything that is not a built-in) in an editor. */
const ours = (editor) =>
  editor.list().filter((a) => !['build', 'plan', 'general', 'explore'].includes(a.id));

test('the roster registers with correct modes, permissions and prompts', () => {
  resetPromptCache();
  const editor = makeAgentEditor();
  const { registered } = registerAgents(editor, loadConfig({ env: {} }));

  assert.equal(registered.length, ROSTER.length);
  assert.equal(editor.state.default, 'superagent');

  for (const agent of ours(editor)) {
    assert.ok(agent.description, `${agent.id}: missing description`);
    assert.ok(['primary', 'subagent', 'all'].includes(agent.mode), `${agent.id}: invalid mode`);
    assert.ok(agent.system && agent.system.length > 100, `${agent.id}: missing system prompt`);
    for (const rule of agent.permissions) {
      assert.ok(['allow', 'ask', 'deny'].includes(rule.effect), `${agent.id}: bad rule effect`);
      assert.equal(typeof rule.resource, 'string', `${agent.id}: rule without a resource`);
    }
  }

  // Workers must not be able to dispatch. Denying with resource "*" removes
  // the subagent tool from the agent entirely, which makes this structural.
  for (const entry of ROSTER.filter((e) => !e.orchestrator)) {
    assert.equal(
      effectFor(editor.get(entry.key), 'subagent'),
      'deny',
      `${entry.key} can still dispatch`,
    );
  }

  // Reviewers and advisors must not be able to edit.
  for (const key of [
    'task-reviewer',
    're-reviewer',
    'code-reviewer',
    'spec-reviewer',
    'plan-reviewer',
    'oracle',
    'librarian',
  ]) {
    assert.equal(effectFor(editor.get(key), 'edit'), 'deny', `${key} can still edit`);
  }

  // The orchestrator's edit scope: denied broadly, allowed under .superagent/,
  // with the broad rule first so the narrow ones win under last-match.
  const edits = editor.get('superagent').permissions.filter((r) => r.action === 'edit');
  assert.deepEqual(
    edits.map((r) => [r.resource, r.effect]),
    [
      ['*', 'deny'],
      ['.superagent/**', 'allow'],
      ['**/.superagent/**', 'allow'],
    ],
  );
});

test('V1 permission names and maps lower to V2 rules', () => {
  assert.deepEqual(toRules({ task: 'deny', bash: 'ask', webfetch: 'allow' }), [
    { action: 'subagent', resource: '*', effect: 'deny' },
    { action: 'shell', resource: '*', effect: 'ask' },
    { action: 'webfetch', resource: '*', effect: 'allow' },
  ]);
  assert.deepEqual(toRules({ edit: { 'src/**': 'allow', '*': 'deny' } }), [
    { action: 'edit', resource: '*', effect: 'deny' },
    { action: 'edit', resource: 'src/**', effect: 'allow' },
  ]);
  // A V2 rule list passes through, and a typo'd effect is dropped, not fatal.
  assert.deepEqual(toRules([{ action: 'task', resource: 'oracle', effect: 'allow' }]), [
    { action: 'subagent', resource: 'oracle', effect: 'allow' },
  ]);
  assert.deepEqual(toRules({ edit: 'nope' }), []);
});

test('permissionOverrides are appended after the roster rules, so they win', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.permissionOverrides = { oracle: { bash: 'deny', edit: 'allow' } };
  const editor = makeAgentEditor();
  registerAgents(editor, settings);
  assert.equal(effectFor(editor.get('oracle'), 'shell'), 'deny');
  assert.equal(effectFor(editor.get('oracle'), 'edit'), 'allow');
});

test('an unrouted model slot omits the model so the agent inherits', () => {
  resetPromptCache();
  const editor = makeAgentEditor();
  registerAgents(editor, loadConfig({ env: {} }));
  for (const agent of ours(editor)) {
    assert.ok(!('model' in agent), `${agent.id}: expected model to be omitted, got ${agent.model}`);
  }
});

test('a routed model slot sets a V2 model reference', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.models.reviewer = 'someprovider/some/model#high';
  const editor = makeAgentEditor();
  registerAgents(editor, settings);
  const ref = { providerID: 'someprovider', id: 'some/model', variant: 'high' };
  assert.deepEqual(editor.get('task-reviewer').model, ref);
  assert.deepEqual(editor.get('re-reviewer').model, ref, 'shares the reviewer slot');
  assert.ok(!('model' in editor.get('implementer')), 'other slots unaffected');
});

test('parseModelRef accepts provider/model and rejects anything else', () => {
  assert.deepEqual(parseModelRef('a/b'), { providerID: 'a', id: 'b' });
  assert.deepEqual(parseModelRef({ providerID: 'a', model: 'b' }), { providerID: 'a', id: 'b' });
  for (const bad of ['nomodel', '/b', 'a/', '', null, 3]) {
    assert.equal(parseModelRef(bad), undefined, `accepted ${JSON.stringify(bad)}`);
  }
});

test('an unavailable or malformed model is dropped rather than substituted', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.models.reviewer = 'ghost/model';
  settings.agents.models.oracle = 'not-a-model-ref';
  const editor = makeAgentEditor();
  registerAgents(editor, settings, { availableModels: new Set(['real/model']) });
  assert.ok(!('model' in editor.get('task-reviewer')), 'should inherit, not fall back');
  assert.ok(!('model' in editor.get('oracle')), 'a malformed ref should inherit');
});

test('temperatures are reported per registered agent name', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.prefix = 'sp-';
  const { temperatures } = registerAgents(makeAgentEditor(), settings);
  assert.equal(temperatures['sp-oracle'], 0.1);
  assert.equal(temperatures['sp-task-reviewer'], 0.1);
  assert.ok(!('sp-implementer' in temperatures), 'implementers follow the model default');
});

test('an existing agent of the same name is never overwritten', () => {
  resetPromptCache();
  const editor = makeAgentEditor(['build', 'implementer']);
  const before = JSON.stringify(editor.get('implementer'));
  const { registered, conflicts } = registerAgents(editor, loadConfig({ env: {} }));

  assert.equal(JSON.stringify(editor.get('implementer')), before, "the user's agent was changed");
  assert.equal(registered.length, ROSTER.length - 1);
  assert.ok(!registered.some((e) => e.key === 'implementer'));
  assert.deepEqual(conflicts, [{ kind: 'agent', name: 'implementer' }]);
});

test('the conflicts list stays empty when nothing collides', () => {
  resetPromptCache();
  assert.deepEqual(registerAgents(makeAgentEditor(), loadConfig({ env: {} })).conflicts, []);
});

test('agents.prefix registers the roster alongside a colliding name', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.prefix = 'sp-';
  const editor = makeAgentEditor(['implementer']);
  const { registered } = registerAgents(editor, settings);

  assert.equal(registered.length, ROSTER.length);
  assert.ok(editor.get('sp-implementer'));
  assert.equal(editor.get('implementer').system, undefined, 'the existing agent was touched');
  assert.equal(editor.state.default, 'sp-superagent');
});

test('the default agent is not selected when the orchestrator was skipped', () => {
  resetPromptCache();
  const editor = makeAgentEditor(['build', 'superagent']);
  registerAgents(editor, loadConfig({ env: {} }));
  assert.equal(editor.state.default, undefined);
});

test("the user's own default_agent is respected", () => {
  resetPromptCache();
  const editor = makeAgentEditor();
  registerAgents(editor, loadConfig({ env: {} }), { defaultAgentConfigured: true });
  assert.equal(editor.state.default, undefined);
});

test('defaultAgentConfigured reads default_agent from the OpenCode config layers', () => {
  withTempDir((dir) => {
    const configDir = path.join(dir, 'config');
    const projectDir = path.join(dir, 'project');
    fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
    fs.mkdirSync(configDir, { recursive: true });
    assert.equal(defaultAgentConfigured({ configDir, projectDir, env: {} }), false);
    fs.writeFileSync(
      path.join(projectDir, '.opencode', 'opencode.jsonc'),
      '{ // mine\n "default_agent": "build", }',
    );
    assert.equal(defaultAgentConfigured({ configDir, projectDir, env: {} }), true);
  });
});

test('defaultAgentConfigured honours OPENCODE_CONFIG_CONTENT', () => {
  const env = { OPENCODE_CONFIG_CONTENT: '{ "default_agent": "build", // inline\n }' };
  assert.equal(defaultAgentConfigured({ env }), true);
  assert.equal(defaultAgentConfigured({ env: { OPENCODE_CONFIG_CONTENT: 'not json' } }), false);
});

test('the solo preset registers nothing', () => {
  resetPromptCache();
  const editor = makeAgentEditor();
  const { registered } = registerAgents(editor, loadConfig({ env: { SUPERAGENT_PRESET: 'solo' } }));
  assert.equal(registered.length, 0);
  assert.equal(editor.state.default, undefined);
  assert.deepEqual(ours(editor), []);
});

test('agents.disable skips named roster entries', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.disable = ['oracle', 'librarian'];
  const editor = makeAgentEditor();
  const { registered } = registerAgents(editor, settings);
  assert.equal(registered.length, ROSTER.length - 2);
  assert.ok(!editor.get('oracle'));
});

test('registration is replay-safe: running the transform twice yields the same agents', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  const once = makeAgentEditor();
  registerAgents(once, settings);
  const twice = makeAgentEditor();
  registerAgents(twice, settings);
  assert.deepEqual(twice.list(), once.list());
});

// --------------------------------------------------------------- skills

test('discoverSkills reads every shipped skill the way OpenCode would', () => {
  const skills = discoverSkills();
  const ids = skills.map((s) => s.id);
  assert.ok(ids.includes('using-superagent'));
  assert.ok(ids.includes('brainstorming'));
  const brainstorming = skills.find((s) => s.id === 'brainstorming');
  assert.ok(brainstorming.description.startsWith('You MUST use this'));
  assert.ok(path.isAbsolute(brainstorming.path));
  assert.ok(!brainstorming.content.startsWith('---'), 'frontmatter should be stripped');
});

test("registerSkills leaves the user's own skill of the same ID alone", () => {
  const mine = { id: 'brainstorming', name: 'mine', path: '/x/SKILL.md', content: 'MINE' };
  const editor = makeSkillEditor([mine]);
  const added = registerSkills(editor, discoverSkills());
  assert.equal(editor.get('brainstorming'), mine);
  assert.ok(!added.includes('brainstorming'));
  assert.ok(added.includes('writing-plans'));
});

test('watchSkills debounces SKILL.md changes into one reload, and stops cleanly', async () => {
  let listener;
  let closed = false;
  const watch = (_dir, _opts, fn) => {
    listener = fn;
    return { close: () => (closed = true) };
  };
  let reloads = 0;
  const stop = watchSkills('/skills', () => (reloads += 1), { delayMs: 5, watch });
  listener('change', 'a/SKILL.md');
  listener('change', 'b/SKILL.md');
  listener('change', 'a/notes.txt');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(reloads, 1);
  stop();
  assert.equal(closed, true);

  // A platform without recursive watch must not take the plugin down.
  const noop = watchSkills('/skills', () => {}, {
    watch: () => {
      throw new Error('unsupported');
    },
  });
  assert.doesNotThrow(noop);
});

// --------------------------------------------------------------- routing

test('the routing table names only registered agents, each distinctly', () => {
  resetPromptCache();
  const { registered } = registerAgents(makeAgentEditor(), loadConfig({ env: {} }));
  const table = renderRoutingTable(registered);

  for (const entry of registered.filter((e) => e.mode !== 'primary')) {
    assert.ok(table.includes(`\`${entry.name}\``), `routing table omits ${entry.name}`);
  }
  assert.ok(!table.includes('`superagent`'), 'the orchestrator should not route to itself');

  // Two agents sharing a model slot still need to be distinguishable, or the
  // orchestrator cannot choose between them.
  const guidance = registered
    .filter((e) => e.mode !== 'primary')
    .map((e) => e.routing ?? e.description);
  assert.equal(new Set(guidance).size, guidance.length, 'two agents share routing guidance');
});

test('the routing table names only agents that were actually registered', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.disable = ['oracle'];
  const table = renderRoutingTable(registerAgents(makeAgentEditor(), settings).registered);
  assert.ok(!table.includes('`oracle`'), 'routes to an agent that was not registered');
});

test('the routing table speaks the V2 subagent tool', () => {
  resetPromptCache();
  const table = renderRoutingTable(
    registerAgents(makeAgentEditor(), loadConfig({ env: {} })).registered,
  );
  // V2's subagent tool has a `model` parameter; the table must steer the
  // orchestrator to agent selection rather than claim the parameter is absent.
  assert.match(table, /Leave the `subagent`\ntool's own `model` unset/);
  assert.ok(!/takes no\s+`model`/.test(table), 'the V1 "no model parameter" claim leaked through');
  assert.ok(table.includes('Dispatch `agent`'));
  assert.ok(table.includes('background: true'));
  assert.ok(!table.includes('subagent_type'), 'the V1 task tool argument leaked through');
  assert.ok(!table.includes('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS'));
});

test('renderConflicts is empty when nothing collided', () => {
  assert.equal(renderConflicts([]), '');
  assert.equal(renderConflicts(undefined), '');
});

test('renderConflicts lists every collision and the prefix remedy', () => {
  const text = renderConflicts([
    { kind: 'agent', name: 'implementer' },
    { kind: 'command', name: 'preset' },
  ]);

  assert.match(text, /agent `implementer`/);
  assert.match(text, /command `\/preset`/);
  assert.match(text, /agents.*prefix/);
  assert.match(text, /sp-/);
});

// ------------------------------------------------- orchestrator prompt

test('the orchestrator prompt carries routing, not methodology', () => {
  const prompt = fs.readFileSync(
    path.join(packageRoot, '.opencode', 'prompts', 'orchestrator.md'),
    'utf8',
  );

  // The routing table is only worth anything if every skill it names resolves.
  // Checked against an explicit list rather than by scanning backticked words:
  // scanning and skipping non-matches makes the assertion tautological, so a
  // renamed or deleted skill would slip through.
  const ROUTED_SKILLS = [
    'brainstorming',
    'writing-plans',
    'subagent-driven-development',
    'using-git-worktrees',
    'systematic-debugging',
    'verification-before-completion',
    'finishing-a-development-branch',
  ];

  for (const skill of ROUTED_SKILLS) {
    // The skill exists...
    assert.ok(
      fs.existsSync(path.join(packageRoot, 'skills', skill, 'SKILL.md')),
      `orchestrator.md routes to "${skill}", which has no skills/${skill}/SKILL.md`,
    );
    // ...and the prompt still routes to it.
    assert.ok(prompt.includes(`\`${skill}\``), `orchestrator.md no longer routes to "${skill}"`);
  }

  const skills = new Set(fs.readdirSync(path.join(packageRoot, 'skills')));

  // The anti-duplication net: the prompt must not restate skill bodies.
  const shingles = (text) => {
    const words = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);
    const out = new Set();
    for (let i = 0; i + 12 <= words.length; i += 1) out.add(words.slice(i, i + 12).join(' '));
    return out;
  };
  const promptShingles = shingles(prompt);
  for (const dir of skills) {
    const skillFile = path.join(packageRoot, 'skills', dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    for (const shingle of shingles(fs.readFileSync(skillFile, 'utf8'))) {
      assert.ok(
        !promptShingles.has(shingle),
        `orchestrator.md duplicates ${dir}/SKILL.md: "${shingle}"`,
      );
    }
  }
});

test('the agent contract tells specialists how to report missing context', () => {
  assert.match(AGENT_CONTRACT, /NEEDS_CONTEXT/);
  assert.match(AGENT_CONTRACT, /SUBAGENT-STOP/);
});

// --------------------------------------------------------------- council

import {
  usableMembers,
  registerCouncillors,
  councilInstruction,
} from '../../.opencode/lib/council.js';
import { commandsToRegister, expandCommand, COMMANDS } from '../../.opencode/lib/commands.js';
import { cachePath, writeCache } from '../../.opencode/lib/update-check.js';

const councilSettings = (members, enabled = true) => {
  const s = loadConfig({ env: {} });
  s.council = { enabled, members, minParticipants: 2 };
  return s;
};

const TWO = [
  { name: 'alpha', model: 'p/a', steering: 'correctness' },
  { name: 'beta', model: 'p/b', steering: 'simplicity' },
];

test('a council needs at least two members to convene', () => {
  assert.deepEqual(usableMembers({ enabled: true, members: [TWO[0]] }), []);
  assert.deepEqual(usableMembers({ enabled: false, members: TWO }), []);
  assert.equal(usableMembers({ enabled: true, members: TWO }).length, 2);
});

test('councillors register as sealed subagents with their own models', () => {
  const editor = makeAgentEditor();
  const { registered } = registerCouncillors(editor, councilSettings(TWO));

  assert.equal(registered.length, 2);
  assert.deepEqual(editor.get('councillor-alpha').model, { providerID: 'p', id: 'a' });
  assert.deepEqual(editor.get('councillor-beta').model, { providerID: 'p', id: 'b' });
  for (const name of ['councillor-alpha', 'councillor-beta']) {
    const agent = editor.get(name);
    assert.equal(agent.mode, 'subagent');
    // A councillor that goes off investigating turns a cheap parallel opinion
    // into an expensive serial one.
    assert.equal(effectFor(agent, 'edit'), 'deny');
    assert.equal(effectFor(agent, 'subagent'), 'deny');
    assert.equal(effectFor(agent, 'shell'), 'deny');
    assert.match(agent.system, /VERDICT:/);
    assert.match(agent.system, /RISK:/);
  }
  assert.match(
    editor.get('councillor-alpha').system,
    /correctness/,
    'steering should reach the prompt',
  );
});

test('councillors are not registered when the council is off', () => {
  const editor = makeAgentEditor();
  assert.deepEqual(registerCouncillors(editor, councilSettings(TWO, false)).registered, []);
  assert.ok(!editor.get('councillor-alpha'));
});

test('an existing agent named like a councillor is never overwritten', () => {
  const editor = makeAgentEditor(['build', 'councillor-alpha']);
  const before = JSON.stringify(editor.get('councillor-alpha'));
  const { registered, conflicts } = registerCouncillors(editor, councilSettings(TWO));

  assert.equal(
    JSON.stringify(editor.get('councillor-alpha')),
    before,
    "the user's agent was changed",
  );
  assert.equal(registered.length, 1);
  assert.ok(!registered.some((r) => r.name === 'councillor-alpha'));
  assert.ok(editor.get('councillor-beta'), 'the non-colliding councillor should still register');
  assert.deepEqual(conflicts, [{ kind: 'agent', name: 'councillor-alpha' }]);
});

test('the council instruction names every registered councillor', () => {
  const { registered } = registerCouncillors(makeAgentEditor(), councilSettings(TWO));
  const text = councilInstruction(registered, 'Which cache strategy?');

  assert.match(text, /councillor-alpha/);
  assert.match(text, /councillor-beta/);
  assert.match(text, /Which cache strategy\?/);
  assert.match(text, /SINGLE message/);
  assert.match(text, /`subagent` calls/);
  assert.ok(!text.includes('subagent_type'), 'the V1 task tool argument leaked through');
  // The failure mode a council exists to prevent.
  assert.match(text, /Do not present one opinion as a consensus/);
});

test('an unconfigured council explains itself instead of dispatching', () => {
  const text = councilInstruction([], 'anything');
  assert.match(text, /not configured/);
  assert.match(text, /"members"/);
  assert.ok(
    !text.includes('councillor-'),
    'must not tell the model to dispatch nonexistent agents',
  );
});

// -------------------------------------------------------------- commands

test('commands register without clobbering existing ones', () => {
  const { commands, conflicts } = commandsToRegister(loadConfig({ env: {} }), new Set(['preset']));
  const names = commands.map((c) => c.name);
  assert.ok(!names.includes('preset'), "the user's command would be shadowed");
  // /board is on by default; /council is not, so it is gated out here.
  assert.ok(names.includes('board'), 'other enabled commands should still register');
  assert.ok(!names.includes('council'));
  assert.deepEqual(conflicts, [{ kind: 'command', name: 'preset' }]);
  assert.equal(Object.keys(COMMANDS).length, 4);
  for (const command of commands) assert.ok(command.description, `${command.name}: no description`);
});

test('/preset show reports the active preset without claiming a change', () => {
  const text = expandCommand('preset', '', { settings: loadConfig({ env: {} }) });
  assert.match(text, /Active preset: \*\*team\*\*/);
  assert.ok(!/restart/i.test(text), 'showing should not talk about restarting');
});

test('/preset switching without --persist is honest that nothing changed', () => {
  const text = expandCommand('preset', 'solo', { settings: loadConfig({ env: {} }) });
  assert.match(text, /not saved, so nothing changed/);
  assert.match(text, /--persist/);
});

test('/preset --persist applies the preset and is honest about the running session', () => {
  withTempDir((dir) => {
    const applied = [];
    const text = expandCommand('preset', 'solo --persist', {
      settings: loadConfig({ env: {} }),
      configDir: dir,
      onPresetPersist: (name) => applied.push(name),
    });
    assert.deepEqual(applied, ['solo']);
    assert.match(text, /is reloading its agents and commands/);
    // A session keeps the agent and model it selected; saying "switched"
    // without this would leave the user believing they are on a model they
    // are not on.
    assert.match(text, /keeps the agent and model it already selected/);
  });
});

test('/preset --persist reports a failed write as a failure, not a missing flag', () => {
  withTempDir((dir) => {
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const text = expandCommand('preset', 'solo --persist', {
      settings: loadConfig({ env: {} }),
      configDir: path.join(blocker, 'config'),
    });
    assert.match(text, /could not be saved/);
    assert.ok(!/Re-run as/.test(text), 'told the user to re-run the command that just failed');
  });
});

test('/preset --persist without a way to apply it says a restart is needed', () => {
  withTempDir((dir) => {
    const text = expandCommand('preset', 'solo --persist', {
      settings: loadConfig({ env: {} }),
      configDir: dir,
      onPresetPersist: () => {
        throw new Error('no reload');
      },
    });
    assert.match(text, /opencode service restart/);
  });
});

test('/preset rejects an unknown name and lists the real ones', () => {
  const text = expandCommand('preset', 'nonsense', { settings: loadConfig({ env: {} }) });
  assert.match(text, /no preset named "nonsense"/);
  assert.match(text, /solo/);
});

test('/preset --persist writes the choice to the state file', () => {
  withTempDir((dir) => {
    const text = expandCommand('preset', 'solo --persist', {
      settings: loadConfig({ env: {} }),
      configDir: dir,
    });
    assert.match(text, /saved/);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, 'superagent.state.json'), 'utf8')).preset,
      'solo',
    );
    // And it must actually be read back on the next load.
    assert.equal(loadConfig({ configDir: dir, env: {} }).preset, 'solo');
  });
});

test('/board reports an empty board rather than nothing', () => {
  const text = expandCommand('board', '', { settings: loadConfig({ env: {} }), sessionID: 'nope' });
  assert.match(text, /job board is empty/);
});

// `/update install` is deliberately not exercised through expandCommand here:
// it shells out for real via `packageRoot` (this checkout's own `.git`), and
// that logic is already fully covered against an injected exec in
// test-update-install.mjs. Only the read-only "check" branch is tested here.

test('/update reports no check yet before one has run', () => {
  withTempDir((dir) => {
    const text = expandCommand('update', '', { settings: loadConfig({ env: {} }), configDir: dir });
    assert.match(text, /No update check has completed yet/);
  });
});

test('/update reports the cached check result', () => {
  withTempDir((dir) => {
    writeCache(cachePath(dir), {
      checkedAt: Date.now(),
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      updateAvailable: true,
    });
    const text = expandCommand('update', '', { settings: loadConfig({ env: {} }), configDir: dir });
    assert.match(text, /Installed version: 0\.1\.0/);
    assert.match(text, /Latest known version: 0\.2\.0/);
    assert.match(text, /update is available/);
  });
});

test('an unknown command is left alone', () => {
  assert.equal(expandCommand('something-else', '', { settings: loadConfig({ env: {} }) }), null);
});

// ------------------------------------------- hardening (PR #1 review)

test('a config file that is valid JSON can never crash the plugin', () => {
  // loadConfig runs at plugin construction, BEFORE any hook is wrapped in
  // guardHook, so a throw here is not caught by anything and the plugin
  // registers nothing at all. deepMerge faithfully carries a null section
  // through, so every section has to be re-checked before it is dereferenced.
  const shapes = [
    '{"council": null}',
    '{"agents": null}',
    '{"board": null}',
    '{"bootstrap": null}',
    '{"agents": {"models": null}}',
    '{"agents": {"temperature": null}}',
    '{"agents": {"disable": "oracle"}}',
    '{"council": {"members": 5}}',
    'null',
    '[]',
    '42',
    '"a string"',
  ];

  withTempDir((dir) => {
    for (const shape of shapes) {
      fs.writeFileSync(path.join(dir, 'superagent.json'), shape);
      const settings = loadConfig({ configDir: dir, env: {} });
      assert.equal(settings.agents.enabled, true, `${shape}: lost agents section`);
      assert.ok(Array.isArray(settings.council.members), `${shape}: members not an array`);
      assert.ok(Array.isArray(settings.agents.disable), `${shape}: disable not an array`);
      assert.equal(settings.preset, 'team', `${shape}: lost the preset`);
    }
  });
});

test('the roster still registers from a config with null sections', () => {
  resetPromptCache();
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'superagent.json'), '{"agents": null, "council": null}');
    assert.equal(
      registerAgents(makeAgentEditor(), loadConfig({ configDir: dir, env: {} })).registered.length,
      ROSTER.length,
    );
  });
});

test('council honours a configured minParticipants above the floor', () => {
  const three = [
    { name: 'a', model: 'p/a' },
    { name: 'b', model: 'p/b' },
    { name: 'c', model: 'p/c' },
  ];
  assert.equal(usableMembers({ enabled: true, members: three, minParticipants: 3 }).length, 3);
  // Two members no longer suffice when the user asked for three.
  assert.deepEqual(
    usableMembers({ enabled: true, members: three.slice(0, 2), minParticipants: 3 }),
    [],
  );
  // But the floor still applies: a "council" of one is a single opinion.
  assert.deepEqual(usableMembers({ enabled: true, members: [three[0]], minParticipants: 1 }), []);
  // A nonsense value falls back to the floor rather than disabling the council.
  assert.equal(usableMembers({ enabled: true, members: three, minParticipants: 'lots' }).length, 3);
});

test('feature commands are not offered when their feature is off', () => {
  const names = commandsToRegister(loadConfig({ env: { SUPERAGENT_PRESET: 'solo' } })).commands.map(
    (c) => c.name,
  );
  // /preset is how you turn the layer back on, so it must survive.
  assert.ok(names.includes('preset'), '/preset should always be available');
  assert.ok(!names.includes('board'), '/board expands to nothing when the board is off');
  assert.ok(!names.includes('council'), '/council expands to nothing when the council is off');
});

test('/preset --persist creates the config directory if it is missing', () => {
  withTempDir((parent) => {
    // First run: OpenCode may not have created its config directory yet.
    const configDir = path.join(parent, 'never-created');
    const text = expandCommand('preset', 'solo --persist', {
      settings: loadConfig({ env: {} }),
      configDir,
    });
    assert.match(text, /saved/, 'the persist request was silently lost');
    assert.equal(loadConfig({ configDir, env: {} }).preset, 'solo');
  });
});

test('a deeply indented prompt body survives extraction', () => {
  // The real templates indent the prompt body 4 spaces and wrap `model:` at 9,
  // which is why the continuation-skipping heuristic never ate prompt content.
  // That is a formatting coincidence, so this pins the intended behaviour: a
  // template that indents its body past the skip threshold still extracts.
  const template = [
    '# Some Prompt Template',
    '',
    '```',
    'Subagent (general-purpose):',
    '  description: "Do a thing"',
    '  model: [MODEL — REQUIRED: choose per SKILL.md Model Selection; an omitted',
    "         model silently inherits the session's most expensive one]",
    '  prompt: |',
    '        You are a deeply indented specialist.',
    '',
    '        ## Your Job',
    '',
    '        Do the thing described in [BRIEF_FILE].',
    '```',
  ].join('\n');

  const extracted = extractDispatchTemplate(template, 'deep-indent');
  assert.match(extracted, /^You are a deeply indented specialist\./);
  assert.match(extracted, /Do the thing described in \[BRIEF_FILE\]/);
  assert.ok(!extracted.includes('[MODEL'), 'the model placeholder should still be dropped');
  assert.ok(!extracted.includes('description:'), 'the description key should still be dropped');
});

test('every template-backed roster entry registers with a real prompt', () => {
  // The failure this guards against is silent: agents.js skips an agent whose
  // prompt could not be extracted, so a broken extractor shows up as a missing
  // specialist rather than an error.
  resetPromptCache();
  const editor = makeAgentEditor();
  registerAgents(editor, loadConfig({ env: {} }));

  for (const entry of ROSTER.filter((e) => e.prompt.kind === 'template')) {
    const agent = editor.get(entry.key);
    assert.ok(agent, `${entry.key} was not registered`);
    assert.ok(
      agent.system.split('\n').length > 30,
      `${entry.key}: prompt is ${agent.system.split('\n').length} lines, expected the full role body`,
    );
  }
});

// ------------------------------------------------- the V2 plugin, end to end

import plugin from '../../.opencode/plugins/superagent.js';
import { userMessage, messageText } from './fake-v2-context.mjs';

const withPlugin = async (options, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-plugin-'));
  const saved = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = path.join(dir, 'config');
  const { before, ...contextOptions } = options;
  before?.(dir);
  const fake = makeContext({ directory: path.join(dir, 'project'), ...contextOptions });
  const cleanup = await plugin.setup(fake.ctx);
  try {
    await fn(fake, dir);
  } finally {
    await cleanup?.();
    if (saved === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('plugin: registers the roster, selects the orchestrator, and replays stably', async () => {
  resetPromptCache();
  await withPlugin({}, async (fake) => {
    const first = fake.agents();
    assert.ok(first.get('superagent'));
    assert.equal(first.state.default, 'superagent');
    assert.deepEqual(fake.agents().list(), first.list(), 'a replay changed the agents');
  });
});

test("plugin: a user's agent wins and the conflict reaches the model once", async () => {
  resetPromptCache();
  await withPlugin(
    { builtinAgents: ['build', 'oracle'], existingCommands: ['board'] },
    async (fake) => {
      fake.agents(); // replay the transform, as a registry read does
      const event = {
        sessionID: 's',
        agent: 'superagent',
        system: [],
        messages: [userMessage('hi')],
        options: {},
      };
      await fake.fire('session', 'context', event);
      const text = messageText(event.messages[0]);
      assert.match(text, /SUPERAGENT_CONFIG_CONFLICTS/);
      assert.match(text, /agent `oracle`/);
      assert.match(text, /command `\/board`/);
      assert.ok(!fake.commands().has('board'), "the user's /board would be shadowed");
    },
  );
});

test('plugin: the context hook applies per-agent temperature only when unset', async () => {
  resetPromptCache();
  await withPlugin({}, async (fake) => {
    fake.agents();
    const oracle = {
      sessionID: 's',
      agent: 'oracle',
      system: [],
      messages: [userMessage('q')],
      options: {},
    };
    await fake.fire('session', 'context', oracle);
    assert.equal(oracle.options.temperature, 0.1);

    const pinned = {
      sessionID: 's',
      agent: 'oracle',
      system: [],
      messages: [userMessage('q')],
      options: { temperature: 0.7 },
    };
    await fake.fire('session', 'context', pinned);
    assert.equal(pinned.options.temperature, 0.7, 'an earlier override was replaced');

    const build = {
      sessionID: 's',
      agent: 'build',
      system: [],
      messages: [userMessage('q')],
      options: {},
    };
    await fake.fire('session', 'context', build);
    assert.equal(build.options.temperature, undefined);
  });
});

test('plugin: a command expands at execution and is submitted as a prompt', async () => {
  resetPromptCache();
  await withPlugin({}, async (fake) => {
    const preset = fake.commands().get('preset');
    assert.ok(preset, '/preset was not registered');
    await preset.execute({
      sessionID: 'ses_1',
      prompt: { text: 'list', files: [] },
      delivery: 'steer',
    });
    assert.equal(fake.prompts.length, 1);
    assert.equal(fake.prompts[0].sessionID, 'ses_1');
    assert.equal(fake.prompts[0].delivery, 'steer');
    assert.deepEqual(fake.prompts[0].files, [], 'prompt attachments were dropped');
    assert.match(fake.prompts[0].text, /Superagent presets:/);
  });
});

test('plugin: a subagent dispatch is recorded, and its ownership conflict annotated', async () => {
  resetPromptCache();
  await withPlugin({}, async (fake) => {
    const dispatch = (id, prompt) => ({
      tool: 'subagent',
      sessionID: 'parent',
      agent: 'superagent',
      messageID: 'm',
      id,
      input: { agent: 'implementer', description: id, prompt, background: true },
    });
    const owns = '<!-- superagent-ownership: write=src/a.js -->\nwork';
    await fake.fire('tool', 'execute.before', dispatch('c1', owns));
    const second = await fake.fire('tool', 'execute.before', dispatch('c2', owns));
    assert.notEqual(second.input.prompt, owns, 'the conflicting prompt was not annotated');

    // Background: the child session id comes back in the tool's result text.
    await fake.fire('tool', 'execute.after', {
      ...dispatch('c1', owns),
      status: 'completed',
      result: {
        content: [{ type: 'text', text: 'working in the background (sessionID: ses_child)' }],
      },
    });
    const event = {
      sessionID: 'parent',
      agent: 'superagent',
      system: [],
      messages: [userMessage('go')],
      options: {},
    };
    await fake.fire('session', 'context', event);
    assert.match(messageText(event.messages.at(-1)), /\| implementer \| c1 \| running \(bg\)/);

    // ...and settles when that child's execution succeeds.
    await fake.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_child' } });
    const later = {
      sessionID: 'parent',
      agent: 'superagent',
      system: [],
      messages: [userMessage('go')],
      options: {},
    };
    await fake.fire('session', 'context', later);
    assert.match(messageText(later.messages.at(-1)), /\| implementer \| c1 \| completed \(bg\)/);
  });
});

test('plugin: a live switch from solo turns the board and its snapshot on', async () => {
  resetPromptCache();
  const { snapshotPath, readSnapshot } = await import('../../.opencode/lib/tui-snapshot.js');
  const before = (dir) => {
    fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'config', 'superagent.json'), '{"preset": "solo"}');
  };
  await withPlugin({ before }, async (fake, dir) => {
    const file = snapshotPath(path.join(dir, 'config'), path.join(dir, 'project'));
    const dispatch = (id) => ({
      tool: 'subagent',
      sessionID: 'ses_live_switch',
      id,
      input: { agent: 'implementer', description: id, prompt: 'go' },
    });
    await fake.fire('tool', 'execute.before', dispatch('c1'));
    assert.equal(readSnapshot(file), null, 'solo should not feed the panel');

    await fake
      .commands()
      .get('preset')
      .execute({
        sessionID: 'ses_live_switch',
        prompt: { text: 'team --persist' },
        delivery: 'steer',
      });
    assert.ok(fake.agents().get('implementer'), 'the roster did not come back');

    await fake.fire('tool', 'execute.before', dispatch('c2'));
    assert.deepEqual(
      readSnapshot(file)?.sessions?.ses_live_switch?.records?.map((r) => r.objective),
      ['c2'],
    );
  });
});
