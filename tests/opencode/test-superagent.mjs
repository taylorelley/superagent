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
import { registerAgents, resetPromptCache } from '../../.opencode/lib/agents.js';
import { renderRoutingTable, renderConflicts } from '../../.opencode/lib/routing.js';
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
    assert.equal(
      config.agent[entry.key].permission.task,
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
  assert.equal(
    config.agent['re-reviewer'].model,
    'someprovider/somemodel',
    'shares the reviewer slot',
  );
  assert.ok(!('model' in config.agent.implementer), 'other slots unaffected');
});

test('an unavailable model is dropped rather than substituted', () => {
  resetPromptCache();
  const settings = loadConfig({ env: {} });
  settings.agents.models.reviewer = 'ghost/model';
  const config = {};
  registerAgents(config, settings, { availableModels: new Set(['real/model']) });
  assert.ok(
    !('model' in config.agent['task-reviewer']),
    'should inherit, not fall back to another model',
  );
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

test('an agent collision is reported through the conflicts collector', () => {
  resetPromptCache();
  const mine = { description: 'MINE', prompt: 'mine' };
  const config = { agent: { implementer: mine } };
  const conflicts = [];
  registerAgents(config, loadConfig({ env: {} }), { conflicts });

  assert.deepEqual(conflicts, [{ kind: 'agent', name: 'implementer' }]);
});

test('the conflicts collector stays empty when nothing collides', () => {
  resetPromptCache();
  const config = {};
  const conflicts = [];
  registerAgents(config, loadConfig({ env: {} }), { conflicts });

  assert.deepEqual(conflicts, []);
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

test('background availability is read from the environment', () => {
  assert.equal(backgroundSubagentsAvailable({}), false);
  assert.equal(
    backgroundSubagentsAvailable({ OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'true' }),
    true,
  );
  assert.equal(
    backgroundSubagentsAvailable({ OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: '1' }),
    true,
  );
  assert.equal(
    backgroundSubagentsAvailable({ OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: 'false' }),
    false,
  );
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
import { registerCommands, expandCommand, COMMANDS } from '../../.opencode/lib/commands.js';
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
  const config = {};
  const registered = registerCouncillors(config, councilSettings(TWO));

  assert.equal(registered.length, 2);
  assert.equal(config.agent['councillor-alpha'].model, 'p/a');
  assert.equal(config.agent['councillor-beta'].model, 'p/b');
  for (const name of ['councillor-alpha', 'councillor-beta']) {
    const agent = config.agent[name];
    assert.equal(agent.mode, 'subagent');
    // A councillor that goes off investigating turns a cheap parallel opinion
    // into an expensive serial one.
    assert.equal(agent.permission.edit, 'deny');
    assert.equal(agent.permission.task, 'deny');
    assert.equal(agent.permission.bash, 'deny');
    assert.match(agent.prompt, /VERDICT:/);
    assert.match(agent.prompt, /RISK:/);
  }
  assert.match(
    config.agent['councillor-alpha'].prompt,
    /correctness/,
    'steering should reach the prompt',
  );
});

test('councillors are not registered when the council is off', () => {
  const config = {};
  assert.deepEqual(registerCouncillors(config, councilSettings(TWO, false)), []);
  assert.deepEqual(config.agent ?? {}, {});
});

test('an existing agent named like a councillor is never overwritten', () => {
  const mine = { description: 'MINE' };
  const config = { agent: { 'councillor-alpha': mine } };
  const registered = registerCouncillors(config, councilSettings(TWO));

  assert.equal(config.agent['councillor-alpha'], mine, "the user's agent was replaced");
  assert.equal(registered.length, 1);
  assert.ok(!registered.some((r) => r.name === 'councillor-alpha'));
  assert.ok(config.agent['councillor-beta'], 'the non-colliding councillor should still register');
});

test('a councillor collision is reported through the conflicts collector', () => {
  const config = { agent: { 'councillor-alpha': { description: 'MINE' } } };
  const conflicts = [];
  registerCouncillors(config, councilSettings(TWO), { conflicts });

  assert.deepEqual(conflicts, [{ kind: 'agent', name: 'councillor-alpha' }]);
});

test('the council instruction names every registered councillor', () => {
  const config = {};
  const registered = registerCouncillors(config, councilSettings(TWO));
  const text = councilInstruction(registered, 'Which cache strategy?');

  assert.match(text, /councillor-alpha/);
  assert.match(text, /councillor-beta/);
  assert.match(text, /Which cache strategy\?/);
  assert.match(text, /SINGLE message/);
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
  const config = { command: { preset: { template: 'MINE' } } };
  registerCommands(config, loadConfig({ env: {} }));
  assert.equal(config.command.preset.template, 'MINE', "the user's command was replaced");
  // /board is on by default; /council is not, so it is gated out here.
  assert.ok(config.command.board, 'other enabled commands should still register');
  assert.equal(Object.keys(COMMANDS).length, 4);
});

test('a command collision is reported through the conflicts collector', () => {
  const config = { command: { preset: { template: 'MINE' } } };
  const conflicts = [];
  registerCommands(config, loadConfig({ env: {} }), { conflicts });

  assert.deepEqual(conflicts, [{ kind: 'command', name: 'preset' }]);
});

test('/preset show reports the active preset without claiming a change', () => {
  const text = expandCommand('preset', '', { settings: loadConfig({ env: {} }) });
  assert.match(text, /Active preset: \*\*team\*\*/);
  assert.ok(!/restart/i.test(text), 'showing should not talk about restarting');
});

test('/preset switching is honest that it needs a restart', () => {
  const text = expandCommand('preset', 'solo', { settings: loadConfig({ env: {} }) });
  // Agents are resolved into cached state at startup. Reporting "switched"
  // without saying this would leave the user believing they are on a model
  // they are not on.
  assert.match(text, /does not take effect until OpenCode restarts/);
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
    const config = {};
    assert.equal(
      registerAgents(config, loadConfig({ configDir: dir, env: {} })).length,
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
  const config = {};
  registerCommands(config, loadConfig({ env: { SUPERAGENT_PRESET: 'solo' } }));
  // /preset is how you turn the layer back on, so it must survive.
  assert.ok(config.command.preset, '/preset should always be available');
  assert.ok(!config.command.board, '/board expands to nothing when the board is off');
  assert.ok(!config.command.council, '/council expands to nothing when the council is off');
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
  const config = {};
  registerAgents(config, loadConfig({ env: {} }));

  for (const entry of ROSTER.filter((e) => e.prompt.kind === 'template')) {
    const agent = config.agent[entry.key];
    assert.ok(agent, `${entry.key} was not registered`);
    assert.ok(
      agent.prompt.split('\n').length > 30,
      `${entry.key}: prompt is ${agent.prompt.split('\n').length} lines, expected the full role body`,
    );
  }
});
