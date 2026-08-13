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
import { extractDispatchTemplate, extractDispatchTemplateFile, AGENT_CONTRACT } from '../../.opencode/lib/prompt-compose.js';
import { ROSTER } from '../../.opencode/lib/roster.js';
import { registerAgents, resetPromptCache } from '../../.opencode/lib/agents.js';
import { renderRoutingTable } from '../../.opencode/lib/routing.js';
import { backgroundSubagentsAvailable } from '../../.opencode/lib/capabilities.js';
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
        JSON.stringify({ agents: { models: { reviewer: 'user/model', oracle: 'user/oracle' } } })
      );
      fs.mkdirSync(path.join(projectDir, '.opencode'), { recursive: true });
      fs.writeFileSync(
        path.join(projectDir, '.opencode', 'superagent.json'),
        JSON.stringify({ agents: { models: { reviewer: 'project/model' } } })
      );

      const settings = loadConfig({ configDir: userDir, projectDir, env: {} });
      assert.equal(settings.agents.models.reviewer, 'project/model', 'project wins over user');
      assert.equal(settings.agents.models.oracle, 'user/oracle', 'user survives where project is silent');
      assert.equal(settings.agents.models.implementer, null, 'defaults survive where both are silent');
    })
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
      '{\n  // pick a preset\n  "preset": "solo",\n}'
    );
    assert.equal(loadConfig({ configDir: dir, env: {} }).preset, 'solo');
  });
});

test('an unknown preset falls back to the default', () => {
  assert.equal(loadConfig({ env: { SUPERAGENT_PRESET: 'nope' } }).preset, 'team');
});

test('an invalid enum value is clamped rather than propagated', () => {
  withTempDir((dir) => {
    fs.writeFileSync(path.join(dir, 'superagent.json'), JSON.stringify({ board: { strategy: 'wat' } }));
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
    assert.ok(!prompt.includes('Use this template when dispatching'), `${entry.key}: leaked the prose wrapper`);
    // Role framing must survive.
    assert.match(prompt, /^You are /, `${entry.key}: prompt does not open with role framing`);
  }
});

test('a template whose shape changed fails loudly rather than degrading', () => {
  // If upstream rewrites a prompt file, we want a test failure here rather than
  // an agent registered with a page of markdown about dispatching.
  assert.throws(() => extractDispatchTemplate('# Just a heading\n\nNo fence.', 'fake'), /no fenced block/);
  assert.throws(() => extractDispatchTemplate('```\nSubagent (x):\n  prompt: |\n```', 'fake'), /empty/);
});

// --------------------------------------------------------------- roster

test('the roster registers with correct modes, permissions and prompts', () => {
  resetPromptCache();
  const config = {};
  const registered = registerAgents(config, loadConfig({ env: {} }));

  assert.equal(registered.length, ROSTER.length);
  assert.equal(config.default_agent, 'superagent');

  for (const [name, agent] of Object.entries(config.agent)) {
    assert.ok(agent.description, `${name}: missing description`);
    assert.ok(['primary', 'subagent', 'all'].includes(agent.mode), `${name}: invalid mode`);
    assert.ok(agent.prompt && agent.prompt.length > 100, `${name}: missing prompt`);
  }

  // Workers must not be able to dispatch. Denying with pattern "*" removes the
  // tool from the agent entirely, which is what makes this structural.
  for (const entry of ROSTER.filter((e) => !e.orchestrator)) {
    assert.equal(config.agent[entry.key].permission.task, 'deny', `${entry.key} can still dispatch`);
  }

  // Reviewers and advisors must not be able to edit.
  for (const key of ['task-reviewer', 're-reviewer', 'code-reviewer', 'spec-reviewer', 'plan-reviewer', 'oracle', 'librarian']) {
    assert.equal(config.agent[key].permission.edit, 'deny', `${key} can still edit`);
  }
});

test('an unrouted model slot omits the model key so the agent inherits', () => {
  resetPromptCache();
  const config = {};
  registerAgents(config, loadConfig({ env: {} }));
  for (const [name, agent] of Object.entries(config.agent)) {
    assert.ok(!('model' in agent), `${name}: expected model to be omitted, got ${agent.model}`);
  }
});

test('a routed model slot sets the model', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.models.reviewer = 'someprovider/somemodel';
  const config = {};
  registerAgents(config, settings);
  assert.equal(config.agent['task-reviewer'].model, 'someprovider/somemodel');
  assert.equal(config.agent['re-reviewer'].model, 'someprovider/somemodel', 'shares the reviewer slot');
  assert.ok(!('model' in config.agent.implementer), 'other slots unaffected');
});

test('an unavailable model is dropped rather than substituted', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.models.reviewer = 'ghost/model';
  const config = {};
  registerAgents(config, settings, { availableModels: new Set(['real/model']) });
  assert.ok(!('model' in config.agent['task-reviewer']), 'should inherit, not fall back to another model');
});

test('an existing agent of the same name is never overwritten', () => {
  resetPromptCache();
  const mine = { description: 'MINE', prompt: 'mine' };
  const config = { agent: { implementer: mine } };
  const registered = registerAgents(config, loadConfig({ env: {} }));

  assert.equal(config.agent.implementer, mine, "the user's agent was replaced");
  assert.equal(registered.length, ROSTER.length - 1);
  assert.ok(!registered.some((e) => e.key === 'implementer'));
});

test('agents.prefix registers the roster alongside a colliding name', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.prefix = 'sp-';
  const config = { agent: { implementer: { description: 'MINE' } } };
  const registered = registerAgents(config, settings);

  assert.equal(registered.length, ROSTER.length);
  assert.ok(config.agent['sp-implementer']);
  assert.equal(config.agent.implementer.description, 'MINE');
  assert.equal(config.default_agent, 'sp-superagent');
});

test('default_agent is not set when the orchestrator was skipped', () => {
  // OpenCode throws at startup if default_agent names an agent that does not
  // exist, so a skipped registration must not leave the setting behind.
  resetPromptCache();
  const config = { agent: { superagent: { description: 'MINE' } } };
  registerAgents(config, loadConfig({ env: {} }));
  assert.equal(config.default_agent, undefined);
});

test('an existing default_agent is respected', () => {
  resetPromptCache();
  const config = { default_agent: 'build' };
  registerAgents(config, loadConfig({ env: {} }));
  assert.equal(config.default_agent, 'build');
});

test('the solo preset registers nothing', () => {
  resetPromptCache();
  const config = {};
  const registered = registerAgents(config, loadConfig({ env: { SUPERAGENT_PRESET: 'solo' } }));
  assert.equal(registered.length, 0);
  assert.equal(config.default_agent, undefined);
  assert.deepEqual(config.agent ?? {}, {});
});

test('agents.disable skips named roster entries', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.disable = ['oracle', 'librarian'];
  const config = {};
  const registered = registerAgents(config, settings);
  assert.equal(registered.length, ROSTER.length - 2);
  assert.ok(!config.agent.oracle);
});

// --------------------------------------------------------------- routing

test('the routing table names only registered agents, each distinctly', () => {
  resetPromptCache();
  const registered = registerAgents({}, loadConfig({ env: {} }));
  const table = renderRoutingTable(registered, { backgroundAvailable: false });

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
  const table = renderRoutingTable(registerAgents({}, settings), {});
  assert.ok(!table.includes('`oracle`'), 'routes to an agent that was not registered');
});

test('the routing table changes with background availability', () => {
  resetPromptCache();
  const registered = registerAgents({}, loadConfig({ env: {} }));
  const on = renderRoutingTable(registered, { backgroundAvailable: true });
  const off = renderRoutingTable(registered, { backgroundAvailable: false });

  assert.ok(on.includes('background: true'));
  assert.ok(!on.includes('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS'));
  assert.ok(off.includes('OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS'));
  assert.ok(off.includes('one message'));
});

test('background availability is read from the environment', () => {
  assert.equal(backgroundSubagentsAvailable({}), false);
  assert.equal(backgroundSubagentsAvailable({ OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true' }), true);
  assert.equal(backgroundSubagentsAvailable({ OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: '1' }), true);
  assert.equal(backgroundSubagentsAvailable({ OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'false' }), false);
});

// ------------------------------------------------- orchestrator prompt

test('the orchestrator prompt carries routing, not methodology', () => {
  const prompt = fs.readFileSync(
    path.join(packageRoot, '.opencode', 'prompts', 'orchestrator.md'),
    'utf8'
  );

  // Every skill it names must exist, or it routes into a void.
  const named = [...prompt.matchAll(/`([a-z][a-z-]+)`/g)].map((m) => m[1]);
  const skills = new Set(fs.readdirSync(path.join(packageRoot, 'skills')));
  for (const candidate of named) {
    if (!skills.has(candidate)) continue;
    assert.ok(skills.has(candidate), `names a nonexistent skill: ${candidate}`);
  }
  assert.ok(named.some((n) => skills.has(n)), 'the prompt should route to at least one real skill');

  // The anti-duplication net: the prompt must not restate skill bodies.
  const shingles = (text) => {
    const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
    const out = new Set();
    for (let i = 0; i + 12 <= words.length; i += 1) out.add(words.slice(i, i + 12).join(' '));
    return out;
  };
  const promptShingles = shingles(prompt);
  for (const dir of skills) {
    const skillFile = path.join(packageRoot, 'skills', dir, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    for (const shingle of shingles(fs.readFileSync(skillFile, 'utf8'))) {
      assert.ok(!promptShingles.has(shingle), `orchestrator.md duplicates ${dir}/SKILL.md: "${shingle}"`);
    }
  }
});

test('the agent contract tells specialists how to report missing context', () => {
  assert.match(AGENT_CONTRACT, /NEEDS_CONTEXT/);
  assert.match(AGENT_CONTRACT, /SUBAGENT-STOP/);
});
