/**
 * Unit tests for the TUI plugin entry.
 *
 * `test-plugin-exports.mjs` exists because a plugin that fails to import is
 * silently inert inside OpenCode. The same is true here, twice over: the TUI
 * host logs through `console.error`, which the running terminal UI paints over,
 * so a broken panel is invisible even to someone looking for it.
 *
 * The entry is driven with a stub V2 TUI context and a recording stand-in for
 * the host's OpenTUI/Solid runtime, which is what loading the runtime lazily
 * buys — nothing in this file needs OpenTUI or a terminal.
 */

import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import entry, {
  createPanelInteractions,
  dispatchState,
  elementFactory,
  loadRuntime,
  newestSessionID,
  panelAgents,
  readVersion,
} from '../../.opencode/tui/superagent-tui.js';
import { loadConfig } from '../../.opencode/lib/config-schema.js';
import { ROSTER } from '../../.opencode/lib/roster.js';
import { MAX_AGENT_ROWS, MAX_DISPATCH_ROWS, panelTheme } from '../../.opencode/lib/tui-panel.js';

const settings = (over = {}) => {
  const base = loadConfig({ env: {} });
  return { ...base, ...over };
};

/** A recording OpenTUI-shaped module. */
const recordingModule = () => ({
  createElement: (tag) => ({ tag, props: {}, children: [] }),
  setProp: (node, key, value) => {
    node.props[key] = value;
  },
  insert: (node, child) => node.children.push(child),
});

/**
 * A minimal stand-in for the host's Solid runtime: `insert(parent, accessor)`
 * evaluates the accessor now and again whenever a signal it read changes —
 * which is the behaviour the panel's liveness depends on.
 */
const reactiveRuntime = () => {
  const mod = recordingModule();
  let tracking = null;
  const createSignal = (value) => {
    const readers = new Set();
    const read = () => {
      if (tracking) readers.add(tracking);
      return value;
    };
    const write = (next) => {
      value = typeof next === 'function' ? next(value) : next;
      for (const run of [...readers]) run();
    };
    return [read, write];
  };
  const insert = (parent, accessor) => {
    if (typeof accessor !== 'function') return parent.children.push(accessor);
    const run = () => {
      const previous = tracking;
      tracking = run;
      try {
        parent.children = [accessor()].filter(Boolean);
      } finally {
        tracking = previous;
      }
    };
    run();
  };
  return { h: elementFactory(mod), insert, createSignal };
};

/** A stub V2 TUI context that records slot claims. */
const stubContext = (over = {}) => {
  const claims = [];
  const toasts = [];
  return {
    claims,
    toasts,
    context: {
      app: { version: '2.2.5' },
      location: { directory: process.cwd() },
      theme: { text: { base: 'T', muted: 'M', feedback: { success: { base: 'S' } } } },
      data: { location: { agent: { sync: async () => {}, list: () => null } } },
      ui: {
        slot: (claim) => {
          claims.push(claim);
          return () => claims.splice(claims.indexOf(claim), 1);
        },
        toast: { show: (t) => toasts.push(t) },
      },
      ...over,
    },
  };
};

const textOf = (node) =>
  typeof node === 'string' ? node : (node?.children ?? []).map((child) => textOf(child)).join(' ');

// ------------------------------------------------------------ module shape

test('the module default-exports the V2 TUI plugin shape', () => {
  assert.equal(typeof entry.setup, 'function');
  assert.equal(typeof entry.id, 'string');
  assert.ok(entry.id.length, 'a TUI part declares its own id');
  assert.equal(entry.tui, undefined, 'the V1 tui() entry is gone');
});

test('the entry imports without OpenTUI present', () => {
  // Reaching this line at all is the assertion: a top-level import of
  // `@opentui/solid` would have thrown before any test ran.
  assert.ok(entry);
});

// --------------------------------------------------------- element factory

test('elementFactory drives the imperative API and skips empty children', () => {
  const created = [];
  const mod = recordingModule();
  const h = elementFactory({
    ...mod,
    createElement: (tag) => {
      const node = mod.createElement(tag);
      created.push(node);
      return node;
    },
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

test('the runtime degrades to nothing when OpenTUI or Solid cannot be reached', async () => {
  assert.equal(await loadRuntime({ solidSpecifiers: ['node:nonexistent-opentui'] }), null);
  assert.equal(
    await loadRuntime({ solidSpecifiers: ['node:fs'] }),
    null,
    'a module without createElement is not one',
  );
});

test('panelTheme flattens V2 semantic tokens and never invents a colour', () => {
  const theme = panelTheme({
    text: {
      base: 'B',
      muted: 'M',
      action: { primary: { base: 'P' } },
      feedback: { success: { base: 'S' }, error: { base: 'E' }, info: { base: 'I' } },
    },
  });
  assert.deepEqual(theme, {
    text: 'B',
    textMuted: 'M',
    accent: 'P',
    info: 'I',
    success: 'S',
    error: 'E',
    warning: undefined,
  });
  assert.deepEqual(Object.values(panelTheme(undefined)).filter(Boolean), []);
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

test("an agent missing from the location's agent list is not claimed as registered", () => {
  const agents = panelAgents(settings(), [{ id: 'build' }, { id: 'oracle' }, { id: 'librarian' }]);
  assert.deepEqual(
    agents.map((a) => a.name),
    ['oracle', 'librarian'],
  );
});

// ---------------------------------------------------------------- session

test('newestSessionID picks the most recently touched session, or nothing', () => {
  assert.equal(
    newestSessionID({ sessions: { old: { updatedAt: 1 }, fresh: { updatedAt: 9 } } }),
    'fresh',
  );
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

// ------------------------------------------------------------ registration

test('the panel is not registered when the runtime is unavailable, and does not throw', async () => {
  const { context, claims } = stubContext();
  const cleanup = await entry.setup(context, { loadRuntime: async () => null });
  assert.equal(claims.length, 0, 'a panel that cannot render must not be registered');
  assert.equal(cleanup, undefined);
});

test('the panel claims sidebar.content and renders for the slot session', async () => {
  const { context, claims } = stubContext();
  const cleanup = await entry.setup(context, { loadRuntime: async () => reactiveRuntime() });
  try {
    assert.equal(claims.length, 1);
    assert.equal(claims[0].append, 'sidebar.content');
    const root = claims[0].render({ sessionID: 'ses_x' });
    assert.match(textOf(root), /Superagent/);
  } finally {
    await cleanup();
  }
  assert.equal(claims.length, 0, 'cleanup should release the slot claim');
});

/** Finds the first node in a recording tree with an onMouseDown handler. */
const findClickable = (node) => {
  if (node?.props?.onMouseDown) return node;
  for (const child of node?.children ?? []) {
    const found = findClickable(child);
    if (found) return found;
  }
  return null;
};

test('a click re-renders the panel in place through the reactive insert', async () => {
  const { context, claims } = stubContext();
  const cleanup = await entry.setup(context, { loadRuntime: async () => reactiveRuntime() });
  try {
    const root = claims[0].render({ sessionID: 'ses_x' });
    const before = root.children[0];
    const clickable = findClickable(root);
    assert.ok(clickable, 'the Agents header should have registered a click handler');
    clickable.props.onMouseDown();
    assert.notEqual(root.children[0], before, 'the click did not repaint the panel');
    assert.equal(root.children.length, 1, 'a repaint must replace the tree, not stack another');
  } finally {
    await cleanup();
  }
});

test('a render failure degrades to an empty panel instead of crashing the TUI', async () => {
  const runtime = reactiveRuntime();
  const broken = {
    ...runtime,
    h: {
      box: runtime.h.box,
      text: () => {
        throw new Error('No renderer found');
      },
    },
  };
  const { context, claims } = stubContext();
  const cleanup = await entry.setup(context, { loadRuntime: async () => broken });
  try {
    assert.doesNotThrow(() => claims[0].render({ sessionID: 'ses_x' }));
  } finally {
    await cleanup();
  }
});

test('the panel is not registered when it is switched off', async () => {
  const { context, claims } = stubContext();
  process.env.SUPERAGENT_DISABLE = '1';
  try {
    await entry.setup(context, { loadRuntime: async () => reactiveRuntime() });
  } finally {
    delete process.env.SUPERAGENT_DISABLE;
  }
  assert.equal(claims.length, 0);
});

test('a preset persisted while the panel runs is picked up without a restart', async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-tui-cfg-'));
  const saved = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = configDir;
  const { context, claims } = stubContext({
    location: { directory: fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-tui-proj-')) },
  });
  const cleanup = await entry.setup(context, { loadRuntime: async () => reactiveRuntime() });
  try {
    const root = claims[0].render({ sessionID: 'ses_x' });
    assert.match(textOf(root), /team/);
    fs.writeFileSync(path.join(configDir, 'superagent.state.json'), '{"preset": "solo"}');
    await new Promise((resolve) => setTimeout(resolve, 1300));
    assert.match(textOf(root), /solo/, 'the panel kept the preset it started with');
    assert.match(textOf(root), /agents off/);
  } finally {
    await cleanup();
    if (saved === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = saved;
  }
});
