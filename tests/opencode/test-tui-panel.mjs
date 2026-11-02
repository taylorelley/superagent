/**
 * Unit tests for the sidebar panel.
 *
 * The panel is rendered with a recording element factory rather than OpenTUI,
 * which is the reason `renderPanel` takes one as an argument: the layout is a
 * pure function of its inputs, and none of this needs a terminal.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_AGENT_ROWS,
  MAX_DETAILED_RUNNING,
  MAX_DISPATCH_ROWS,
  OBJECTIVE_MAX,
  PANEL_WIDTH,
  renderPanel,
  shortModel,
} from '../../.opencode/lib/tui-panel.js';

const THEME = {
  text: 'text',
  textMuted: 'muted',
  accent: 'accent',
  info: 'info',
  success: 'success',
  error: 'error',
  warning: 'warning',
  border: 'border',
  borderSubtle: 'borderSubtle',
};

const factory = () => ({
  box: (props, children = []) => ({ tag: 'box', props, children }),
  text: (props, children = []) => ({ tag: 'text', props, children }),
});

const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
};

/** Every string the panel would print, in order. */
const lines = (node) => {
  const out = [];
  walk(node, (n) => {
    if (n.tag !== 'text') return;
    for (const child of n.children ?? []) if (typeof child === 'string') out.push(child);
  });
  return out;
};

/** Every colour the panel asked for. */
const colors = (node) => {
  const out = new Set();
  walk(node, (n) => {
    if (n.props?.fg !== undefined) out.add(n.props.fg);
    if (n.props?.borderColor !== undefined) out.add(n.props.borderColor);
    if (n.props?.backgroundColor !== undefined) out.add(n.props.backgroundColor);
  });
  return [...out];
};

/** The first box whose direct text children include the exact label `needle`. */
const boxWithLabel = (node, needle) => {
  let found = null;
  walk(node, (n) => {
    if (found || n.tag !== 'box') return;
    const hasLabel = (n.children ?? []).some(
      (c) => c?.tag === 'text' && (c.children ?? []).includes(needle),
    );
    if (hasLabel) found = n;
  });
  return found;
};

/** The first text node whose string child contains `needle`. */
const textContaining = (node, needle) => {
  let found = null;
  walk(node, (n) => {
    if (found || n.tag !== 'text') return;
    if ((n.children ?? []).some((c) => typeof c === 'string' && c.includes(needle))) found = n;
  });
  return found;
};

// A fixed clock: fixtures start at t=1, and a wall-clock `now` would time them in decades.
const render = (model) => renderPanel({ theme: THEME, now: 60_000, ...model }, factory());

const dispatch = (over = {}) => ({
  agent: 'implementer',
  objective: 'do the thing',
  state: 'completed',
  background: false,
  owns: [],
  startedAt: 1,
  endedAt: 2,
  ...over,
});

// ---------------------------------------------------------------- footer

test('configuration is one footer line: preset, agent count, version', () => {
  const text = lines(
    render({
      version: '0.1.0',
      preset: 'team',
      subsystems: { agents: true, board: true },
      agents: [{ name: 'a' }, { name: 'b' }],
    }),
  );

  assert.ok(text.includes('Superagent v0.1.0'), JSON.stringify(text));
  assert.ok(text.includes('team · 2 agents'));
  assert.ok(!text.some((line) => line.includes(' on')), 'subsystems that are on are not news');
});

test('the footer comes last, after the live sections', () => {
  const text = lines(render({ preset: 'team', records: [dispatch()] }));
  const footer = text.findIndex((line) => line.includes('Superagent'));
  assert.ok(footer > text.findIndex((line) => line === 'Subagents'));
});

test('a subsystem that is off is named, since it explains missing behaviour', () => {
  const text = lines(render({ subsystems: { agents: false, board: false, council: true } }));
  const flags = text.find((line) => line.includes('off'));
  assert.ok(flags?.includes('agents off'), JSON.stringify(text));
  assert.ok(flags.includes('board off'));
  assert.ok(flags.includes('council on'));
});

test('the council is only mentioned when it is on, since it is off by default', () => {
  const text = lines(render({ subsystems: { agents: true, board: true, council: false } }));
  assert.ok(!text.some((line) => line.includes('council')));
});

test('a panel with nothing to report still renders', () => {
  const text = lines(renderPanel(undefined, factory()));
  assert.ok(text.some((line) => line.includes('Superagent')));
  assert.ok(text.includes('none this session'));
});

test('an update is announced above the footer', () => {
  const text = lines(render({ updateAvailable: true, latestVersion: '0.2.0' }));
  const notice = text.findIndex((line) => line.includes('v0.2.0 available'));
  assert.ok(notice >= 0);
  assert.ok(notice < text.findIndex((line) => line.includes('Superagent')));
});

// -------------------------------------------------------------------- agents

const roster = (n, model = null) =>
  Array.from({ length: n }, (_, i) => ({ name: `agent-${i}`, model }));

test('the roster is hidden by default: it is configuration, not activity', () => {
  const text = lines(render({ agents: [{ name: 'oracle', model: 'anthropic/claude-opus-4-1' }] }));
  assert.ok(!text.includes('  oracle'));
  assert.ok(!text.some((line) => line.includes('claude-opus')));
});

test('expanding shows the full roster, capped', () => {
  const text = lines(render({ agents: roster(MAX_AGENT_ROWS + 3), agentsExpanded: true }));
  assert.equal(text.filter((line) => line.includes('agent-')).length, MAX_AGENT_ROWS);
  assert.ok(text.some((line) => line.includes('+3 more')));
});

test('an empty expanded roster says none registered', () => {
  const text = lines(render({ agents: [], agentsExpanded: true }));
  assert.ok(text.some((line) => line.includes('none registered')));
});

test('an unrouted slot says it inherits rather than showing nothing', () => {
  const text = lines(
    render({ agents: [{ name: 'implementer', model: null }], agentsExpanded: true }),
  );
  assert.ok(text.some((line) => line.includes('implementer')));
  assert.ok(text.includes('inherit'));
});

test('routed agents sort first and lose their provider prefix', () => {
  const text = lines(
    render({
      agentsExpanded: true,
      agents: [
        { name: 'implementer', model: null },
        { name: 'oracle', model: 'anthropic/claude-opus-4-1' },
      ],
    }),
  );
  const pos = (needle) => text.findIndex((line) => line.includes(needle));
  assert.ok(pos('oracle') < pos('implementer'), 'the routed slot leads');
  assert.ok(text.includes('claude-opus-4-1'));
  assert.ok(!text.some((line) => line.includes('anthropic/')));
});

test('the footer carries the roster toggle as onMouseDown', () => {
  const onToggleAgents = () => {};
  const tree = render({ version: '0.1.0', onToggleAgents });
  const footer = boxWithLabel(tree, 'Superagent v0.1.0');
  assert.equal(footer?.props?.onMouseDown, onToggleAgents);
});

test('the expanded "+N more" line carries the reveal-more-agents handler', () => {
  const onRevealMoreAgents = () => {};
  const overflow = textContaining(
    render({ agents: roster(MAX_AGENT_ROWS + 3), agentsExpanded: true, onRevealMoreAgents }),
    'more',
  );
  assert.equal(overflow?.props?.onMouseDown, onRevealMoreAgents);
});

test('a larger agentRowLimit reveals more of the expanded roster', () => {
  const text = lines(
    render({
      agents: roster(MAX_AGENT_ROWS + 3),
      agentsExpanded: true,
      agentRowLimit: MAX_AGENT_ROWS + 3,
    }),
  );
  assert.equal(text.filter((line) => line.includes('agent-')).length, MAX_AGENT_ROWS + 3);
  assert.ok(!text.some((line) => line.includes('more')), 'nothing left to reveal');
});

// ---------------------------------------------------------------- plan / main

test('the plan section shows the file, progress, and the current task', () => {
  const text = lines(
    render({
      plan: { name: '2026-11-02-panel.md', done: 3, total: 7, current: 'Task 4: Export conflicts' },
    }),
  );
  assert.equal(text[0], 'Plan', 'the plan leads the panel');
  assert.ok(text.includes('3/7'));
  assert.ok(text.includes('2026-11-02-panel.md'));
  assert.ok(text.some((line) => line.startsWith('▸') && line.includes('Task 4')));
});

test('no plan means no plan section', () => {
  assert.ok(!lines(render({})).includes('Plan'));
});

test('the main agent shows its skill, what it is doing, and for how long', () => {
  const text = lines(
    render({
      now: 62_000,
      main: { state: 'running', skill: 'brainstorming', current: 'read board.js', since: 20_000 },
    }),
  );
  assert.ok(text.includes('Main · brainstorming'));
  assert.ok(text.some((line) => line.includes('● read board.js')));
  assert.ok(text.includes('0:42'));
});

test('an idle main agent says so, without a timer', () => {
  const text = lines(render({ main: { state: 'idle', skill: null } }));
  assert.ok(text.includes('Main'));
  assert.ok(text.includes('idle'));
});

test('sections run plan, main, subagents, then configuration', () => {
  const text = lines(
    render({
      plan: { name: 'p.md', done: 0, total: 1 },
      main: { state: 'idle' },
      records: [dispatch()],
    }),
  );
  const order = ['Plan', 'Main', 'Subagents'].map((label) => text.indexOf(label));
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
  );
  assert.ok(order.every((i) => i >= 0));
});

// ---------------------------------------------------------------- dispatches

test('a missing snapshot says so instead of pretending there were no dispatches', () => {
  const text = lines(render({ snapshotState: 'none' }));
  assert.ok(text.some((line) => line.includes('no snapshot yet')));
  assert.ok(!text.some((line) => line.includes('none this session')));
});

test('an incompatible snapshot is named as such', () => {
  const text = lines(render({ snapshotState: 'incompatible' }));
  assert.ok(text.some((line) => line.includes('different plugin version')));
});

test('a server/panel version mismatch names both versions', () => {
  const text = lines(
    render({ snapshotState: 'version-mismatch', pluginVersion: '6.3.0', version: '0.1.0' }),
  );
  assert.ok(text.some((line) => line.includes('6.3.0') && line.includes('0.1.0')));
});

test('the subagents header counts what is running against the total', () => {
  const text = lines(render({ records: [dispatch({ state: 'running' }), dispatch(), dispatch()] }));
  assert.ok(text.includes('Subagents'));
  assert.ok(text.includes('1/3'), 'one of three is running');
});

test('running dispatches come first, then the most recently finished', () => {
  const text = lines(
    render({
      records: [
        dispatch({ agent: 'old', endedAt: 10 }),
        dispatch({ agent: 'recent', endedAt: 90 }),
        dispatch({ agent: 'live', state: 'running', endedAt: undefined, startedAt: 5 }),
      ],
    }),
  );

  // Rows are prefixed with a state glyph, so match on a substring.
  const pos = (needle) => text.findIndex((line) => line.includes(needle));
  assert.ok(pos('live') < pos('recent'));
  assert.ok(pos('recent') < pos('old'));
});

test('every row names its agent and objective; ownership is shown only while running', () => {
  const text = lines(
    render({
      records: [
        dispatch({
          agent: 'live',
          state: 'running',
          objective: 'rewrite parser',
          owns: ['src/parse/**'],
        }),
        dispatch({ agent: 'done', objective: 'earlier work', owns: ['src/other/**'] }),
      ],
    }),
  );

  assert.ok(text.some((line) => line.includes('live · rewrite parser')));
  assert.ok(text.some((line) => line.includes('owns') && line.includes('src/parse/**')));
  assert.ok(
    text.some((line) => line.includes('done · earlier work')),
    'rows are told apart',
  );
  assert.ok(!text.some((line) => line.includes('src/other/**')), 'a finished row holds nothing');
});

test('a running row is timed from its start; a finished one shows its duration', () => {
  const text = lines(
    render({
      now: 200_000,
      records: [
        dispatch({ agent: 'live', state: 'running', startedAt: 66_000, endedAt: undefined }),
        dispatch({ agent: 'done', startedAt: 10_000, endedAt: 75_000 }),
      ],
    }),
  );
  assert.ok(text.includes('2:14'), JSON.stringify(text));
  assert.ok(text.includes('1:05'));
});

test('a finished row shows what came back; a failed one shows why', () => {
  const tree = render({
    records: [
      dispatch({ agent: 'ok', result: 'Found 3 call sites' }),
      dispatch({ agent: 'bad', state: 'error', result: 'npm test exited 1' }),
    ],
  });
  const text = lines(tree);
  assert.ok(text.some((line) => line.includes('→ Found 3 call sites')));
  assert.equal(textContaining(tree, 'npm test exited 1')?.props?.fg, 'error');
});

test('a running row shows what its subagent is doing, from the host session', () => {
  const text = lines(
    render({
      records: [dispatch({ agent: 'general', state: 'running', childSessionID: 'c1' })],
      children: [{ id: 'c1', agent: 'general', title: 'x', state: 'running', current: 'glob *' }],
    }),
  );
  assert.ok(text.some((line) => line.trim() === 'glob *'));
});

test('an unlinked record is matched to its child by agent and title', () => {
  const text = lines(
    render({
      records: [dispatch({ agent: 'general', objective: 'Count files', state: 'running' })],
      children: [
        { id: 'c1', agent: 'general', title: 'Count files', state: 'running', current: 'glob *' },
      ],
    }),
  );
  assert.ok(text.some((line) => line.trim() === 'glob *'));
  assert.equal(text.filter((line) => line.includes('Count files')).length, 1, 'no duplicate row');
});

test('a running child with no record still gets a row', () => {
  const text = lines(
    render({
      snapshotState: 'none',
      children: [{ id: 'c1', agent: 'explore', title: 'Find callers', state: 'running' }],
    }),
  );
  assert.ok(text.some((line) => line.includes('explore · Find callers')));
  assert.ok(!text.some((line) => line.includes('no snapshot yet')));
});

test('an ownership conflict is called out, in the warning colour', () => {
  const tree = render({
    records: [dispatch({ state: 'running', owns: ['a/**'], conflicts: ['reviewer'] })],
  });
  const warning = textContaining(tree, 'overlaps reviewer');
  assert.ok(warning);
  assert.equal(warning.props.fg, 'warning');
});

test('detail lines are drawn for a few running rows only', () => {
  const records = Array.from({ length: MAX_DETAILED_RUNNING + 2 }, (_, i) =>
    dispatch({ agent: `agent-${i}`, state: 'running', owns: [`dir${i}/**`] }),
  );
  const text = lines(render({ records, dispatchRowLimit: 10 }));
  assert.equal(text.filter((line) => line.includes('owns')).length, MAX_DETAILED_RUNNING);
});

test('a background dispatch is marked as one', () => {
  const text = lines(render({ records: [dispatch({ state: 'running', background: true })] }));
  assert.ok(text.some((line) => line.startsWith('bg')));
});

test('long lines are truncated to the column, not wrapped', () => {
  const text = lines(
    render({
      records: [
        dispatch({ state: 'running', objective: 'x'.repeat(200), owns: ['y'.repeat(200)] }),
      ],
    }),
  );

  const row = text.find((entry) => entry.includes('xxx'));
  assert.ok(row, 'the objective is shown');
  assert.ok(row.length <= PANEL_WIDTH, `row was ${row.length} characters`);
  assert.ok(row.includes('…'));

  const owns = text.find((entry) => entry.includes('yyy'));
  assert.ok(
    owns.trim().length <= OBJECTIVE_MAX,
    `owns line was ${owns.trim().length} characters, and its label counts too`,
  );
});

test('dispatch states carry a glyph so outcome reads without scanning colours', () => {
  const text = lines(
    render({
      records: [
        dispatch({ state: 'running' }),
        dispatch({ state: 'completed' }),
        dispatch({ state: 'error' }),
      ],
    }),
  );
  assert.ok(text.some((line) => line.includes('●')));
  assert.ok(text.some((line) => line.includes('✓')));
  assert.ok(text.some((line) => line.includes('✗')));
});

test('a busy session is capped and says how much it is hiding', () => {
  const records = Array.from({ length: MAX_DISPATCH_ROWS + 4 }, (_, i) =>
    dispatch({ agent: `agent-${i}`, endedAt: i }),
  );
  const text = lines(render({ records }));

  assert.equal(text.filter((line) => line.includes('agent-')).length, MAX_DISPATCH_ROWS);
  assert.ok(text.includes('+4 more'));
});

test('the Subagents "+N more" line carries the reveal-more-dispatches handler', () => {
  const onRevealMoreDispatches = () => {};
  const records = Array.from({ length: MAX_DISPATCH_ROWS + 4 }, (_, i) =>
    dispatch({ agent: `agent-${i}`, endedAt: i }),
  );
  const overflow = textContaining(render({ records, onRevealMoreDispatches }), 'more');
  assert.equal(overflow?.props?.onMouseDown, onRevealMoreDispatches);
});

test('a larger dispatchRowLimit reveals more of a busy session', () => {
  const records = Array.from({ length: MAX_DISPATCH_ROWS + 4 }, (_, i) =>
    dispatch({ agent: `agent-${i}`, endedAt: i }),
  );
  const text = lines(render({ records, dispatchRowLimit: MAX_DISPATCH_ROWS + 4 }));
  assert.equal(text.filter((line) => line.includes('agent-')).length, MAX_DISPATCH_ROWS + 4);
  assert.ok(!text.some((line) => line.includes('more')), 'nothing left to reveal');
});

test('dispatch state is coloured by outcome, so a failure is not just more text', () => {
  const used = colors(
    render({
      records: [
        dispatch({ state: 'running', endedAt: undefined }),
        dispatch({ state: 'error' }),
        dispatch({ state: 'completed' }),
      ],
    }),
  );

  assert.ok(used.includes('info'), 'running');
  assert.ok(used.includes('error'), 'failed');
  assert.ok(used.includes('success'), 'completed');
});

test('an unknown state still renders, in a neutral colour', () => {
  const tree = render({ records: [dispatch({ state: 'something-new' })] });
  assert.ok(lines(tree).some((line) => line.includes('something-new')));
  assert.ok(colors(tree).every((color) => Object.values(THEME).includes(color)));
});

test('a record missing state renders "unknown", not the literal word undefined', () => {
  const tree = render({ records: [dispatch({ state: undefined })] });
  assert.ok(lines(tree).some((line) => line.startsWith('unknown')));
  assert.ok(!lines(tree).some((line) => line.includes('undefined')));
});

// --------------------------------------------------------------------- theme

test('every colour comes from the theme, so the panel follows it', () => {
  const tree = render({
    version: '1.0.0',
    agents: [{ name: 'oracle', model: 'x/y' }],
    records: [
      dispatch({ state: 'running', owns: ['a/**'], conflicts: ['x'] }),
      dispatch({ result: 'ok' }),
      dispatch({ state: 'error', result: 'no' }),
    ],
    main: { state: 'running', current: 'read a.js', since: 0 },
    plan: { name: 'p.md', done: 1, total: 2, current: 'Task 2' },
    updateAvailable: true,
    agentsExpanded: true,
  });

  const themed = new Set(Object.values(THEME));
  for (const color of colors(tree)) {
    assert.ok(themed.has(color), `${color} is not a theme colour`);
  }
});

test('a theme missing a colour renders rather than crashing', () => {
  const text = lines(renderPanel({ theme: {}, records: [dispatch()] }, factory()));
  assert.ok(text.some((line) => line.includes('Superagent')));
});

// ---------------------------------------------------------------- shortModel

test('shortModel keeps the identifying tail of a model id', () => {
  assert.equal(shortModel('anthropic/claude-opus-4-1'), 'claude-opus-4-1');
  assert.equal(shortModel('gpt-5'), 'gpt-5');
  assert.equal(shortModel(null), '');
  assert.equal(shortModel('   '), '');

  const long = shortModel('provider/' + 'a'.repeat(80), 10);
  assert.equal(long.length, 10);
  assert.ok(long.startsWith('…'));
});

test('every row fits the sidebar with a gap, however long its parts', () => {
  const tree = render({
    version: '0.1.0',
    preset: 'a-very-long-preset-name',
    agents: Array.from({ length: 10 }, (_, i) => ({ name: `a${i}` })),
    now: 4_000_000,
    main: {
      state: 'running',
      skill: 'subagent-driven-development',
      current: 'x'.repeat(80),
      since: 0,
    },
    records: [
      dispatch({ state: 'running', background: true, objective: 'y'.repeat(80), startedAt: 0 }),
    ],
  });
  walk(tree, (n) => {
    if (n.tag !== 'box' || n.props?.flexDirection !== 'row') return;
    const [left, right] = n.children.map((c) => c.children.join(''));
    assert.ok(
      left.length + (right ? right.length + 1 : 0) <= PANEL_WIDTH,
      `"${left}" + "${right}" overflows ${PANEL_WIDTH}`,
    );
  });
});
