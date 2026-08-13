/**
 * Unit tests for the TUI plugin entry.
 *
 * `test-plugin-exports.mjs` exists because a plugin that fails to import is
 * silently inert inside OpenCode. The same is true here, twice over: the TUI
 * host logs through `console.error`, which the running terminal UI paints over,
 * so a broken panel is invisible even to someone looking for it.
 *
 * The entry is driven with a stub `api`, which is what the lazy import of the
 * element factory buys — nothing in this file needs OpenTUI or a terminal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import entry, {
  currentSessionID,
  elementFactory,
  loadElementFactory,
  newestSessionID,
  panelAgents,
  readVersion,
} from '../../.opencode/tui/superagent-tui.js';
import { loadConfig } from '../../.opencode/lib/config-schema.js';
import { ROSTER } from '../../.opencode/lib/roster.js';

const settings = (over = {}) => {
  const base = loadConfig({ env: {} });
  return { ...base, ...over };
};

const stubApi = (over = {}) => ({
  state: { path: { directory: process.cwd() }, config: {} },
  theme: { current: { text: 'text', textMuted: 'muted' } },
  renderer: { requestRender: () => {} },
  lifecycle: { onDispose: () => {} },
  slots: { register: () => {} },
  ...over,
});

// ------------------------------------------------------------ module shape

test('the module default-exports the tui plugin OpenCode expects', () => {
  assert.equal(typeof entry.tui, 'function');
  assert.equal(typeof entry.id, 'string');
  assert.ok(entry.id.length, 'path plugins are rejected without an id');
  assert.equal(entry.server, undefined, 'a module exports server() or tui(), never both');
});

test('the entry imports without OpenTUI present', () => {
  // Reaching this line at all is the assertion: a top-level import of
  // `@opentui/solid` would have thrown before any test ran.
  assert.ok(entry);
});

// --------------------------------------------------------- element factory

test('elementFactory drives the imperative API and skips empty children', () => {
  const created = [];
  const h = elementFactory({
    createElement: (tag) => {
      const node = { tag, props: {}, children: [] };
      created.push(node);
      return node;
    },
    setProp: (node, key, value) => {
      node.props[key] = value;
    },
    insert: (node, child) => node.children.push(child),
  });

  const tree = h.box({ width: '100%', missing: undefined }, [
    h.text({ fg: 'text' }, ['hello']),
    null,
    undefined,
    false,
    [h.text({}, ['nested'])],
  ]);

  assert.equal(tree.tag, 'box');
  assert.deepEqual(tree.props, { width: '100%' }, 'undefined props are not set');
  assert.equal(tree.children.length, 2, 'empty children are dropped, arrays are flattened');
  assert.equal(created.length, 3);
});

test('the element factory degrades to nothing when OpenTUI cannot be reached', async () => {
  assert.equal(await loadElementFactory(['node:nonexistent-opentui']), null);
  assert.equal(await loadElementFactory(['node:fs']), null, 'a module without createElement is not one');
});

// ---------------------------------------------------------------- version

test('readVersion reports this package version, and shrugs off a bad root', () => {
  assert.match(readVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(readVersion('/nonexistent'), null);
});

// ----------------------------------------------------------------- roster

test('the panel roster mirrors what the plugin would register', () => {
  const agents = panelAgents(settings(), null);
  assert.deepEqual(
    agents.map((a) => a.name),
    ROSTER.map((entry) => entry.key)
  );
  assert.ok(agents.every((a) => a.model === null), 'nothing is routed by default');
});

test('the panel roster honours prefix, disable, and model routing', () => {
  const base = settings();
  const agents = panelAgents(
    {
      ...base,
      agents: {
        ...base.agents,
        prefix: 'sa-',
        disable: ['oracle'],
        models: { ...base.agents.models, orchestrator: 'anthropic/claude-opus-4-1' },
      },
    },
    null
  );

  assert.ok(agents.every((a) => a.name.startsWith('sa-')));
  assert.ok(!agents.some((a) => a.name === 'sa-oracle'));
  assert.equal(agents.find((a) => a.name === 'sa-superagent').model, 'anthropic/claude-opus-4-1');
});

test('agents disabled entirely means an empty roster', () => {
  const base = settings();
  assert.deepEqual(panelAgents({ ...base, agents: { ...base.agents, enabled: false } }, null), []);
});

test('an agent missing from the resolved config is not claimed as registered', () => {
  const agents = panelAgents(settings(), { agent: { oracle: {}, librarian: {} } });
  assert.deepEqual(agents.map((a) => a.name), ['oracle', 'librarian']);
});

// ---------------------------------------------------------------- session

test('the current session comes from the route when there is one', () => {
  const snapshot = { sessions: { old: { updatedAt: 1 }, fresh: { updatedAt: 9 } } };
  const api = stubApi({ route: { current: { name: 'session', params: { sessionID: 'routed' } } } });

  assert.equal(currentSessionID(api, undefined, snapshot), 'routed');
  assert.equal(currentSessionID(stubApi(), { session_id: 'from-props' }, snapshot), 'from-props');
  assert.equal(currentSessionID(stubApi(), undefined, snapshot), 'fresh', 'falls back to newest');
});

test('newestSessionID has nothing to pick from an empty snapshot', () => {
  assert.equal(newestSessionID(null), null);
  assert.equal(newestSessionID({ sessions: {} }), null);
});

// ------------------------------------------------------------ registration

test('the panel is not registered when OpenTUI is unavailable, and does not throw', async () => {
  let registered = 0;
  await entry.tui(stubApi({ slots: { register: () => (registered += 1) } }), undefined, {});
  assert.equal(registered, 0, 'a panel that cannot render must not be registered');
});

test('the panel is not registered when it is switched off', async () => {
  let registered = 0;
  const api = stubApi({ slots: { register: () => (registered += 1) } });

  process.env.SUPERAGENT_DISABLE = '1';
  try {
    await entry.tui(api, undefined, {});
  } finally {
    delete process.env.SUPERAGENT_DISABLE;
  }

  assert.equal(registered, 0);
});
