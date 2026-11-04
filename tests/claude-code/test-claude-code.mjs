/**
 * Unit tests for the Claude Code plugin's pure modules, run under Node.
 *
 * The hooks module itself is exercised by `claude plugin test`
 * (tests/claude-code/superagent.test.ts), which has no filesystem and so feeds
 * it stand-in prompt files. These tests cover what that cannot: the real
 * prompt templates going through the shared extraction, the manifests, and
 * the translations from OpenCode's vocabulary (models, permissions, paths).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROSTER } from '../../core/roster.js';
import { resolveSettings } from '../../core/config.js';
import { mergeRules, evaluate, hiddenActions } from '../../core/permissions.js';
import { renderRoutingTable } from '../../core/routing.js';
import { councilInstruction } from '../../core/council.js';
import { renderBootstrap } from '../../core/bootstrap.js';
import { TOOL_MAPS } from '../../core/tool-map.js';
import {
  buildRoster,
  buildCouncil,
  promptPaths,
  toClaudeModel,
  safeName,
} from '../../claude-code/lib/roster.js';
import { checkCall, pathCandidates, toolRequest } from '../../claude-code/lib/tools.js';
import { claudeConfigDir, configFiles } from '../../claude-code/lib/paths.js';
import { presetCommand, updatePlan } from '../../claude-code/lib/commands.js';
import {
  isFirstRequest,
  judgeHostHooks,
  isBlocked,
  fallbackNotice,
  fallbackLine,
} from '../../claude-code/lib/fallback.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const realPrompts = () => Object.fromEntries(promptPaths().map((p) => [p, read(p)]));

// ------------------------------------------------------------ manifests

test('the plugin manifest names the hooks module and matches package.json', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(manifest.name, 'superagent');
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.hooks, './claude-code/hooks.json');
  const hooks = JSON.parse(read('claude-code/hooks.json'));
  assert.deepEqual(hooks.modules, ['./superagent.js']);
  assert.ok(fs.existsSync(path.join(root, 'claude-code', 'superagent.js')));
});

test('the marketplace lists the plugin at the repository root, at the same version', () => {
  const market = JSON.parse(read('.claude-plugin/marketplace.json'));
  const pkg = JSON.parse(read('package.json'));
  assert.equal(market.plugins.length, 1);
  assert.equal(market.plugins[0].name, 'superagent');
  assert.equal(market.plugins[0].source, './');
  assert.equal(market.plugins[0].version, pkg.version);
});

test('every manifest the release bumps is declared in .version-bump.json', () => {
  const declared = JSON.parse(read('.version-bump.json')).files.map((f) => `${f.path}:${f.field}`);
  assert.ok(declared.includes('package.json:version'));
  assert.ok(declared.includes('.claude-plugin/plugin.json:version'));
  assert.ok(declared.includes('.claude-plugin/marketplace.json:plugins.0.version'));
});

// ------------------------------------------------------- hooks-module imports

/** Every file the hooks module imports, transitively. */
const importGraph = (entry) => {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/gm)) {
      const spec = match[1];
      assert.ok(
        spec.startsWith('.'),
        `${path.relative(root, file)} imports "${spec}": a hooks module may import only its own files`,
      );
      visit(path.resolve(path.dirname(file), spec));
    }
  };
  visit(entry);
  return [...seen];
};

test('the hooks module imports only plugin files that need no Node or host globals', () => {
  const files = importGraph(path.join(root, 'claude-code', 'superagent.js'));
  assert.ok(files.length > 5);
  for (const file of files) {
    const rel = path.relative(root, file);
    assert.ok(!rel.startsWith('..'), `${rel} is outside the plugin`);
    assert.ok(!rel.startsWith('.opencode'), `${rel}: the hooks module must not load OpenCode code`);
    const code = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /\bimport\s*\(/, `${rel} uses a dynamic import`);
    assert.doesNotMatch(code, /\brequire\s*\(/, `${rel} uses require`);
    // `process` exists only on OpenCode's side; core reads it as globalThis.process?.
    assert.doesNotMatch(code, /(?<![.\w])process\./, `${rel} reads process directly`);
  }
});

// --------------------------------------------------------------- roster

const settings = (overrides = {}, env = {}) => resolveSettings({ userFile: overrides, env });

test('the roster builds from the real prompt files, every specialist and the orchestrator', () => {
  const roster = buildRoster(settings(), realPrompts());
  assert.deepEqual(roster.warnings, []);
  assert.equal(roster.specs.length, ROSTER.length - 1);
  assert.ok(roster.orchestrator);
  assert.match(roster.orchestrator.prompt, /You are the Superagent orchestrator/);
  for (const spec of roster.specs) {
    assert.match(spec.name, /^[A-Za-z0-9_-]{1,64}$/);
    assert.ok(spec.description.length > 10);
    assert.ok(spec.prompt.length > 100, `${spec.name} has a real prompt`);
    // Workers never dispatch; that is structural, as on OpenCode.
    assert.ok(spec.disallowedTools.includes('Agent'), `${spec.name} cannot dispatch`);
  }
  const implementer = roster.specs.find((s) => s.name === 'implementer');
  assert.match(implementer.prompt, /SUPERAGENT_CONTRACT/);
  assert.doesNotMatch(implementer.prompt, /^Subagent \(/m);
  for (const reviewer of ['task-reviewer', 're-reviewer', 'code-reviewer', 'oracle', 'librarian']) {
    const spec = roster.specs.find((s) => s.name === reviewer);
    assert.ok(spec.disallowedTools.includes('Edit'), `${reviewer} cannot edit`);
  }
});

test('prefix, disable and the solo preset shape the roster', () => {
  const prefixed = buildRoster(
    settings({ agents: { prefix: 'sp-', disable: ['oracle'] } }),
    realPrompts(),
  );
  assert.ok(prefixed.specs.some((s) => s.name === 'sp-implementer'));
  assert.ok(!prefixed.specs.some((s) => s.name.endsWith('oracle')));
  assert.ok(prefixed.registered.some((r) => r.name === 'superagent:sp-implementer'));

  const solo = buildRoster(settings({ preset: 'solo' }), realPrompts());
  assert.equal(solo.specs.length, 0);
  assert.equal(solo.orchestrator, null);
});

test('a missing prompt file skips its agent with a warning', () => {
  const prompts = realPrompts();
  delete prompts['.opencode/prompts/oracle.md'];
  const roster = buildRoster(settings(), prompts);
  assert.ok(!roster.specs.some((s) => s.name === 'oracle'));
  assert.match(roster.warnings.join('\n'), /oracle\.md/);
});

test('permission overrides narrow what an agent may do', () => {
  const roster = buildRoster(
    settings({ agents: { permissionOverrides: { implementer: { bash: 'deny' } } } }),
    realPrompts(),
  );
  const spec = roster.specs.find((s) => s.name === 'implementer');
  assert.ok(spec.disallowedTools.includes('Bash'));
});

test('models: aliases, full ids and provider/model are Claude; others inherit', () => {
  assert.deepEqual(toClaudeModel(null), {});
  assert.deepEqual(toClaudeModel('haiku'), { model: 'haiku' });
  assert.deepEqual(toClaudeModel('claude-opus-5-5'), { model: 'claude-opus-5-5' });
  assert.deepEqual(toClaudeModel('anthropic/claude-sonnet-5-5#high'), {
    model: 'claude-sonnet-5-5',
    effort: 'high',
  });
  assert.deepEqual(toClaudeModel('us.anthropic.claude-opus-5-5-v1:0'), {
    model: 'us.anthropic.claude-opus-5-5-v1:0',
  });
  assert.deepEqual(toClaudeModel({ providerID: 'anthropic', id: 'claude-haiku-5-5' }), {
    model: 'claude-haiku-5-5',
  });
  assert.match(toClaudeModel('openai/gpt-5').warning, /not a Claude model/);
  const roster = buildRoster(
    settings({ agents: { models: { reviewer: 'openai/gpt-5', oracle: 'opus' } } }),
    realPrompts(),
  );
  assert.equal(roster.specs.find((s) => s.name === 'task-reviewer').model, undefined);
  assert.equal(roster.specs.find((s) => s.name === 'oracle').model, 'opus');
  assert.match(roster.warnings.join('\n'), /reviewer.*not a Claude model/);
});

test('councillors are sealed and routed', () => {
  const council = buildCouncil(settings(), [
    { name: 'alpha', model: 'opus', steering: 'risk' },
    { name: 'beta two', model: 'sonnet' },
  ]);
  assert.deepEqual(
    council.specs.map((s) => s.name),
    ['councillor-alpha', 'councillor-beta-two'],
  );
  for (const spec of council.specs) {
    for (const tool of ['Edit', 'Write', 'Agent', 'Bash'])
      assert.ok(spec.disallowedTools.includes(tool));
  }
  assert.match(council.specs[0].prompt, /Your assigned emphasis: risk/);
  assert.equal(safeName('a b/c'), 'a-b-c');
});

// ---------------------------------------------------------- permissions

test('the orchestrator may write only its workspace, by either path form', () => {
  const rules = buildRoster(settings(), realPrompts()).orchestrator.rules;
  const cwd = '/work/project';
  const decide = (file) => checkCall(rules, 'Write', { file_path: file, content: '' }, { cwd });
  assert.equal(decide('/work/project/src/app.js').decision, 'deny');
  assert.equal(decide('src/app.js').decision, 'deny');
  assert.equal(decide('/work/project/.superagent/plan.md'), null);
  assert.equal(decide('.superagent/briefs/t1.md'), null);
  assert.equal(decide('/elsewhere/.superagent/x.md'), null);
  assert.equal(checkCall(rules, 'Bash', { command: 'ls' }, { cwd }), null);
  assert.equal(checkCall(rules, 'mcp__x__y', {}, { cwd }), null);
});

test('rules follow OpenCode: last match wins, ask asks, * hides', () => {
  const rules = mergeRules({ bash: { '*': 'allow', 'git push*': 'ask', 'rm -rf*': 'deny' } });
  assert.equal(checkCall(rules, 'Bash', { command: 'git status' }), null);
  assert.equal(checkCall(rules, 'Bash', { command: 'git push origin' }).decision, 'ask');
  assert.equal(checkCall(rules, 'Bash', { command: 'rm -rf /' }).decision, 'deny');
  assert.deepEqual(hiddenActions(mergeRules({ edit: 'deny', webfetch: 'allow' })), ['edit']);
  assert.equal(evaluate(mergeRules({ edit: 'deny' }), 'edit', []), 'deny');
});

test('tool calls map to rule actions and resources', () => {
  assert.deepEqual(pathCandidates('/w/p/src/a.js', '/w/p'), ['src/a.js', '/w/p/src/a.js']);
  assert.deepEqual(pathCandidates('./src/a.js', '/w/p'), ['src/a.js', '/w/p/src/a.js']);
  assert.deepEqual(pathCandidates('C:\\w\\p\\a.js', 'C:\\w\\p'), ['a.js', 'C:/w/p/a.js']);
  assert.deepEqual(toolRequest('Agent', { subagent_type: 'Explore' }), {
    action: 'subagent',
    resources: ['Explore'],
  });
  assert.equal(toolRequest('TaskOutput', {}), null);
});

// ------------------------------------------------------ host vocabulary

test('the routing table and council speak Claude Code', () => {
  const roster = buildRoster(settings(), realPrompts());
  const table = renderRoutingTable(roster.registered, { host: 'claude' });
  assert.match(table, /\| Dispatch `subagent_type` \|/);
  assert.match(table, /`superagent:implementer`/);
  assert.match(table, /`Explore`/);
  assert.match(table, /`general-purpose`/);
  assert.match(table, /run_in_background: true/);
  assert.match(table, /SendMessage/);
  assert.doesNotMatch(table, /`background: true`|sessionID/);
  const opencode = renderRoutingTable(roster.registered);
  assert.match(opencode, /`background: true`/);

  const council = councilInstruction(
    [{ name: 'superagent:councillor-a' }, { name: 'superagent:councillor-b' }],
    'Q?',
    {
      host: 'claude',
    },
  );
  assert.match(council, /parallel\n`Agent` calls/);
  assert.match(council, /subagent_type: `superagent:councillor-a`/);
});

test('the bootstrap carries the Claude Code tool map', () => {
  const text = renderBootstrap(read('skills/using-superagent/SKILL.md'), { host: 'claude' });
  assert.match(text, /^<EXTREMELY_IMPORTANT>/);
  assert.match(text, /Tool Mapping for Claude Code/);
  assert.match(text, /`Agent` with `subagent_type: "general-purpose"`/);
  assert.doesNotMatch(text, /^name: using-superagent/m);
  assert.equal(TOOL_MAPS.claude.mappings.length, TOOL_MAPS.opencode.mappings.length);
});

// ------------------------------------------------------- paths, commands

test('config lives under Claude Code’s directories', () => {
  assert.equal(claudeConfigDir({ HOME: '/home/u' }), '/home/u/.claude');
  assert.equal(claudeConfigDir({ HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' }), '/cfg');
  assert.equal(claudeConfigDir({ USERPROFILE: 'C:\\Users\\u' }), 'C:/Users/u/.claude');
  assert.equal(claudeConfigDir({}), null);
  assert.deepEqual(configFiles({ configDir: '/home/u/.claude', projectDir: '/w/p' }), {
    user: '/home/u/.claude/superagent.json',
    project: '/w/p/.claude/superagent.json',
    state: '/home/u/.claude/superagent.state.json',
  });
});

test('/preset parses like OpenCode’s', () => {
  const s = settings();
  assert.match(presetCommand(s, '').text, /Active preset: team/);
  assert.match(presetCommand(s, 'list').text, /team {2}\(active\)/);
  assert.match(presetCommand(s, 'nope').text, /no preset named "nope"/);
  assert.match(presetCommand(s, 'solo').text, /was not saved/);
  assert.deepEqual(presetCommand(s, 'solo --persist'), { persist: 'solo' });
});

test('/update install pulls a checkout, otherwise asks Claude Code', () => {
  assert.deepEqual(updatePlan({ isGitCheckout: true, root: '/p', pluginId: 'superagent' }).argv, [
    'git',
    '-C',
    '/p',
    'pull',
    '--ff-only',
  ]);
  assert.deepEqual(updatePlan({ isGitCheckout: false, root: '/p', pluginId: 'superagent' }).argv, [
    'claude',
    'plugin',
    'update',
    'superagent',
  ]);
});

// ------------------------------------------------- another plugin runs first

test('the prompt-hook verdict is taken on the first request of a new session only', () => {
  assert.equal(isFirstRequest({ index: 0, messageCount: 15 }, 1), true);
  assert.equal(isFirstRequest({ index: 0, messageCount: 15 }, 0), true);
  assert.equal(isFirstRequest({ index: 1, messageCount: 15 }, 1), false);
  assert.equal(isFirstRequest({ index: 0, agentId: 'a1' }, 1), false);
  assert.equal(isFirstRequest({ index: 0 }, 3), false, 'a reloaded or resumed session');
  assert.equal(isFirstRequest({ index: 0 }, undefined), false, 'turns unknown');
});

test('only a hook that was wanted and did not run counts as passed by', () => {
  const seen = { compose: false, context: true };
  assert.deepEqual(judgeHostHooks({ seen, wantRole: true, wantBootstrap: true }), {
    role: true,
    bootstrap: false,
  });
  assert.deepEqual(
    judgeHostHooks({
      seen: { compose: false, context: false },
      wantRole: false,
      wantBootstrap: false,
    }),
    { role: false, bootstrap: false },
    'setDefaultAgent: false and no bootstrap want nothing',
  );
  assert.equal(isBlocked({ role: false, bootstrap: false }), false);
  assert.equal(isBlocked(null), false);
});

test('the fallback notice names what was lost and what still works', () => {
  assert.equal(fallbackNotice({ role: false, bootstrap: false }), null);
  assert.equal(fallbackLine({ role: false, bootstrap: false }), null);

  const both = fallbackNotice({ role: true, bootstrap: true }, { pluginName: 'superagent' });
  assert.match(both, /the orchestrator role and the session bootstrap/);
  assert.match(both, /agents, skills, job board and commands still work/);
  assert.match(both, /no orchestrator model routing and no write guard/);
  assert.match(both, /\/superagent:using-superagent/);
  assert.doesNotMatch(both, /\u2014/, 'no em dashes');

  const roleOnly = fallbackNotice({ role: true, bootstrap: false });
  assert.doesNotMatch(roleOnly, /using-superagent/);
  const bootOnly = fallbackNotice({ role: false, bootstrap: true });
  assert.doesNotMatch(bootOnly, /write guard/);

  assert.equal(fallbackLine({ role: true, bootstrap: true }), '⚠ orchestrator off: org policy');
  assert.equal(fallbackLine({ role: false, bootstrap: true }), '⚠ bootstrap off: org policy');
  assert.ok(fallbackLine({ role: true, bootstrap: true }).length <= 35, 'fits the sidebar');
});
