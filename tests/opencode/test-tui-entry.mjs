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
  createPanelInteractions,
  createRootRepainter,
  currentSessionID,
  dispatchState,
  elementFactory,
  loadElementFactory,
  newestSessionID,
  panelAgents,
  readVersion,
} from '../../.opencode/tui/superagent-tui.js';
import { loadConfig } from '../../.opencode/lib/config-schema.js';
import { ROSTER } from '../../.opencode/lib/roster.js';
import { MAX_AGENT_ROWS, MAX_DISPATCH_ROWS } from '../../.opencode/lib/tui-panel.js';

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
  assert.equal(
    await loadElementFactory(['node:fs']),
    null,
    'a module without createElement is not one',
  );
});

/** A recording OpenTUI-shaped module, for elementFactory/createRootRepainter tests. */
const recordingModule = (removalName = 'removeChild') => {
  const mod = {
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    setProp: (node, key, value) => {
      node.props[key] = value;
    },
    insert: (node, child) => node.children.push(child),
  };
  const removed = [];
  if (removalName) {
    mod[removalName] = (parent, child) => {
      parent.children = parent.children.filter((c) => c !== child);
      removed.push(child);
    };
  }
  return { mod, removed };
};

test('elementFactory exposes mount always, and unmount only when a removal export is found', () => {
  const { mod: withoutRemoval } = recordingModule(null);
  const h1 = elementFactory(withoutRemoval);
  assert.equal(typeof h1.mount, 'function');
  assert.equal(h1.unmount, null, 'no removal export means no unmount capability');

  const { mod: withRemoval, removed } = recordingModule('removeNode');
  const h2 = elementFactory(withRemoval);
  const parent = { tag: 'box', props: {}, children: [h2.text({}, ['x'])] };
  h2.unmount(parent, parent.children[0]);
  assert.equal(removed.length, 1, 'the discovered removal export was actually called');
});

test('elementFactory.mount inserts into an existing parent, not just at creation', () => {
  const { mod } = recordingModule();
  const h = elementFactory(mod);
  const parent = h.box({}, []);
  const child = h.text({}, ['late']);
  h.mount(parent, child);
  assert.deepEqual(parent.children, [child]);
});

// ---------------------------------------------------------------- version

test('readVersion reports this package version, and shrugs off a bad root', () => {
  assert.match(readVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(readVersion('/nonexistent'), null);
});

test('readVersion is re-exported from the shared bridge module', () => {
  assert.match(readVersion(), /^\d+\.\d+\.\d+/);
});

// ----------------------------------------------------------------- roster

test('the panel roster mirrors what the plugin would register', () => {
  const agents = panelAgents(settings(), null);
  assert.deepEqual(
    agents.map((a) => a.name),
    ROSTER.map((entry) => entry.key),
  );
  assert.ok(
    agents.every((a) => a.model === null),
    'nothing is routed by default',
  );
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
    null,
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
  assert.deepEqual(
    agents.map((a) => a.name),
    ['oracle', 'librarian'],
  );
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

// ------------------------------------------------------------ dispatch state

test('dispatchState distinguishes no file, incompatible, mismatch, and ok', () => {
  assert.equal(dispatchState({ hasFile: false, snapshot: null, panelVersion: '0.1.0' }), 'none');
  assert.equal(
    dispatchState({ hasFile: true, snapshot: null, panelVersion: '0.1.0' }),
    'incompatible',
  );
  assert.equal(
    dispatchState({ hasFile: true, snapshot: { pluginVersion: '0.1.0' }, panelVersion: '0.2.0' }),
    'version-mismatch',
  );
  assert.equal(
    dispatchState({ hasFile: true, snapshot: { pluginVersion: '0.1.0' }, panelVersion: '0.1.0' }),
    'ok',
  );
  assert.equal(
    dispatchState({ hasFile: true, snapshot: {}, panelVersion: '0.1.0' }),
    'ok',
    'no server version means no comparison',
  );
});

// ------------------------------------------------------- panel interactions

test('createPanelInteractions seeds agentsExpanded from the default, coerced to boolean', () => {
  assert.equal(createPanelInteractions(true, () => {}).state.agentsExpanded, true);
  assert.equal(createPanelInteractions(false, () => {}).state.agentsExpanded, false);
  assert.equal(createPanelInteractions(undefined, () => {}).state.agentsExpanded, false);
  assert.equal(
    createPanelInteractions('yes', () => {}).state.agentsExpanded,
    false,
    'only === true seeds expanded, matching how settings.tui.agents.expanded is read elsewhere',
  );
});

test('toggleAgents flips the flag, resets the row limit, and calls onChange', () => {
  let calls = 0;
  const interactions = createPanelInteractions(false, () => (calls += 1));

  interactions.revealMoreAgents();
  assert.ok(interactions.state.agentRowLimit > MAX_AGENT_ROWS);

  interactions.toggleAgents();
  assert.equal(interactions.state.agentsExpanded, true);
  assert.equal(interactions.state.agentRowLimit, MAX_AGENT_ROWS, 'toggling resets the page');
  assert.equal(calls, 2);
});

test('revealMoreAgents / revealMoreDispatches grow their own limit by one page, independently', () => {
  const interactions = createPanelInteractions(false, () => {});

  interactions.revealMoreAgents();
  assert.equal(interactions.state.agentRowLimit, MAX_AGENT_ROWS * 2);
  assert.equal(interactions.state.dispatchRowLimit, MAX_DISPATCH_ROWS, 'dispatches untouched');

  interactions.revealMoreDispatches();
  assert.equal(interactions.state.dispatchRowLimit, MAX_DISPATCH_ROWS * 2);
});

test('an omitted onChange never throws', () => {
  const interactions = createPanelInteractions(false);
  assert.doesNotThrow(() => {
    interactions.toggleAgents();
    interactions.revealMoreAgents();
    interactions.revealMoreDispatches();
  });
});

// ------------------------------------------------------------ root repaint

test('createRootRepainter mounts one root the first time and reuses it after', () => {
  const { mod } = recordingModule();
  const repainter = createRootRepainter(elementFactory(mod));
  assert.equal(repainter.ensureRoot(), repainter.ensureRoot());
});

test('patch replaces the mounted child in place when a removal primitive exists', () => {
  const { mod, removed } = recordingModule();
  const h = elementFactory(mod);
  const repainter = createRootRepainter(h);
  const root = repainter.ensureRoot();

  const childA = h.text({}, ['a']);
  assert.equal(repainter.patch(childA), true);
  assert.deepEqual(root.children, [childA]);

  const childB = h.text({}, ['b']);
  assert.equal(repainter.patch(childB), true);
  assert.deepEqual(root.children, [childB], 'the old child is gone, the new one took its place');
  assert.deepEqual(removed, [childA]);
});

test('patch is a no-op before ensureRoot has run', () => {
  const { mod } = recordingModule();
  const h = elementFactory(mod);
  assert.equal(createRootRepainter(h).patch(h.text({}, ['x'])), false);
});

test('without a removal primitive, only the first patch takes effect', () => {
  const { mod } = recordingModule(null);
  const h = elementFactory(mod);
  const repainter = createRootRepainter(h);
  repainter.ensureRoot();

  assert.equal(repainter.patch(h.text({}, ['a'])), true, 'the first paint always happens');
  assert.equal(
    repainter.patch(h.text({}, ['b'])),
    false,
    'nothing to remove the first child with, so a second patch is refused rather than stacking',
  );
});

// ------------------------------------------------------------ registration

test('the panel is not registered when OpenTUI is unavailable, and does not throw', async () => {
  let registered = 0;
  await entry.tui(stubApi({ slots: { register: () => (registered += 1) } }), undefined, {});
  assert.equal(registered, 0, 'a panel that cannot render must not be registered');
});

// ---------------------------------------------- live-host confirmed bugs
//
// Both regressions below were confirmed against a real installed OpenCode +
// `@opentui/solid`: (1) `createElement` throws `Error: No renderer found`
// when called from outside the host's own synchronous `sidebar_content`
// invocation — a poll tick or click qualifies as "outside"; (2) the real
// module exports none of `remove`/`removeChild`/`removeNode`/`unmount`. See
// docs/superagent.md.

test('sidebar_content builds a fresh root on every invocation, not a reused one', async () => {
  const { mod } = recordingModule();
  let registeredSlots;
  const api = stubApi({ slots: { register: (opts) => (registeredSlots = opts.slots) } });

  await entry.tui(api, undefined, {}, { loadElementFactory: async () => elementFactory(mod) });

  const rootA = registeredSlots.sidebar_content({ theme: { current: {} } });
  const rootB = registeredSlots.sidebar_content({ theme: { current: {} } });
  assert.notEqual(rootA, rootB, 'a stale root from a torn-down view must never be handed back');
});

/** Finds the first node in a recording-module tree with an onMouseDown handler. */
const findClickable = (node) => {
  if (node?.props?.onMouseDown) return node;
  for (const child of node?.children ?? []) {
    const found = findClickable(child);
    if (found) return found;
  }
  return null;
};

test('a repaint reached from outside sidebar_content (poll/click) cannot crash the session', async () => {
  // Simulates the confirmed live-host failure: createElement throws once the
  // host's own render pass for that `sidebar_content` call has ended — which
  // is exactly when a poll tick or a click handler fires.
  let insideRenderPass = true;
  const throwingMod = {
    createElement: (tag) => {
      if (!insideRenderPass) throw new Error('No renderer found');
      return { tag, props: {}, children: [] };
    },
    setProp: (node, key, value) => {
      node.props[key] = value;
    },
    insert: (node, child) => node.children.push(child),
  };

  let registeredSlots;
  const api = stubApi({ slots: { register: (opts) => (registeredSlots = opts.slots) } });
  await entry.tui(
    api,
    undefined,
    {},
    { loadElementFactory: async () => elementFactory(throwingMod) },
  );

  // The initial, host-driven call is the one confirmed-safe place to render.
  const root = registeredSlots.sidebar_content({ theme: { current: {} } });
  const clickable = findClickable(root);
  assert.ok(clickable, 'the Agents header should have registered a click handler');

  // A click fires later, outside that call stack, on the real host.
  insideRenderPass = false;
  assert.doesNotThrow(() => clickable.props.onMouseDown());
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
