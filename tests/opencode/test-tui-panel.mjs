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
  MAX_DISPATCH_ROWS,
  OBJECTIVE_MAX,
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

const render = (model) => renderPanel({ theme: THEME, ...model }, factory());

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

// ------------------------------------------------------------------ identity

test('the identity line reports version, preset, and which subsystems are on', () => {
  const text = lines(
    render({
      version: '0.1.0',
      preset: 'team',
      subsystems: { agents: true, board: false, council: true },
    })
  );

  assert.ok(text.includes('Superagent'));
  assert.ok(text.includes('v0.1.0'));
  assert.ok(
    text.some((line) => line.includes('team') && line.includes('agents on') && line.includes('board off')),
    `expected a subsystem summary, got ${JSON.stringify(text)}`
  );
  assert.ok(text.some((line) => line.includes('council on')));
});

test('the council is only mentioned when it is on, since it is off by default', () => {
  const text = lines(render({ subsystems: { agents: true, board: true, council: false } }));
  assert.ok(!text.some((line) => line.includes('council')));
});

test('a panel with nothing to report still renders', () => {
  const text = lines(renderPanel(undefined, factory()));
  assert.ok(text.includes('Superagent'));
  assert.ok(text.includes('none registered'));
  assert.ok(text.includes('none this session'));
});

// -------------------------------------------------------------------- agents

test('agents are collapsed by default: header count plus routed slots only', () => {
  const text = lines(
    render({
      agents: [
        { name: 'implementer', model: null },
        { name: 'oracle', model: 'anthropic/claude-opus-4-1' },
      ],
    })
  );

  assert.ok(text.includes('oracle'), 'the routed slot is the exception worth showing');
  assert.ok(!text.includes('implementer'), 'an inheriting slot is hidden when collapsed');
  assert.ok(text.some((line) => line.includes('1 collapsed')), 'the hidden count is stated');
});

test('collapsed mode is capped too: routed slots past the budget count as hidden', () => {
  const agents = Array.from({ length: MAX_AGENT_ROWS + 3 }, (_, i) => ({
    name: `agent-${i}`,
    model: 'anthropic/claude-opus-4-1',
  }));
  const text = lines(render({ agents }));

  assert.equal(
    text.filter((line) => line.includes('agent-')).length,
    MAX_AGENT_ROWS,
    'a fully-routed roster must not outgrow the sidebar just because it is collapsed'
  );
  assert.ok(text.some((line) => line.includes('3 collapsed')));
});

test('expanding via config shows the full roster, capped as before', () => {
  const agents = Array.from({ length: MAX_AGENT_ROWS + 3 }, (_, i) => ({
    name: `agent-${i}`,
    model: null,
  }));
  const text = lines(render({ agents, agentsExpanded: true }));

  assert.equal(text.filter((line) => line.includes('agent-')).length, MAX_AGENT_ROWS);
  assert.ok(text.includes('+3 more'));
});

test('an empty roster still says none registered, collapsed or not', () => {
  assert.ok(lines(render({ agents: [] })).some((line) => line.includes('none registered')));
});

test('an unrouted slot says it inherits rather than showing nothing', () => {
  const text = lines(render({ agents: [{ name: 'implementer', model: null }], agentsExpanded: true }));
  assert.ok(text.includes('implementer'));
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
    })
  );

  assert.ok(text.indexOf('oracle') < text.indexOf('implementer'), 'the routed slot leads');
  assert.ok(text.includes('claude-opus-4-1'));
  assert.ok(!text.some((line) => line.includes('anthropic/')));
});

test('a long roster is capped so the panel cannot outgrow the sidebar', () => {
  const agents = Array.from({ length: MAX_AGENT_ROWS + 3 }, (_, i) => ({
    name: `agent-${i}`,
    model: null,
  }));
  const text = lines(render({ agents, agentsExpanded: true }));

  assert.equal(text.filter((line) => line.includes('agent-')).length, MAX_AGENT_ROWS);
  assert.ok(text.includes('+3 more'));
});

test('agents off means no roster, not an empty one', () => {
  const text = lines(render({ agents: [], subsystems: { agents: false, board: true } }));
  assert.ok(text.includes('none registered'));
  assert.ok(text.some((line) => line.includes('agents off')));
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
  const text = lines(render({ snapshotState: 'version-mismatch', pluginVersion: '6.3.0', version: '0.1.0' }));
  assert.ok(text.some((line) => line.includes('6.3.0') && line.includes('0.1.0')));
});

test('the dispatch header counts what is running against the total', () => {
  const text = lines(
    render({ records: [dispatch({ state: 'running' }), dispatch(), dispatch()] })
  );
  assert.ok(text.includes('2/3') || text.includes('1/3'), JSON.stringify(text));
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
    })
  );

  // Rows are prefixed with a state glyph, so match on a substring.
  const pos = (needle) => text.findIndex((line) => line.includes(needle));
  assert.ok(pos('live') < pos('recent'));
  assert.ok(pos('recent') < pos('old'));
});

test('a running dispatch shows its objective and what it owns; a finished one does not', () => {
  const text = lines(
    render({
      records: [
        dispatch({
          agent: 'live',
          state: 'running',
          objective: 'rewrite the parser',
          owns: ['src/parse/**'],
        }),
        dispatch({ agent: 'done', objective: 'earlier work', owns: ['src/other/**'] }),
      ],
    })
  );

  assert.ok(text.some((line) => line.includes('rewrite the parser')));
  assert.ok(text.some((line) => line.includes('owns') && line.includes('src/parse/**')));
  assert.ok(!text.some((line) => line.includes('earlier work')), 'history stays one line');
  assert.ok(!text.some((line) => line.includes('src/other/**')));
});

test('a background dispatch is marked as one', () => {
  const text = lines(render({ records: [dispatch({ state: 'running', background: true })] }));
  assert.ok(text.some((line) => line.includes('running') && line.includes('(bg)')));
});

test('long detail lines are truncated to the column, not wrapped', () => {
  const text = lines(
    render({
      records: [
        dispatch({ state: 'running', objective: 'x'.repeat(200), owns: ['y'.repeat(200)] }),
      ],
    })
  );

  const objective = text.find((entry) => entry.includes('xxx'));
  assert.ok(objective, 'the objective is shown');
  assert.ok(
    objective.trim().length <= OBJECTIVE_MAX,
    `objective line was ${objective.trim().length} characters`
  );
  assert.ok(objective.includes('…'));

  const owns = text.find((entry) => entry.includes('yyy'));
  assert.ok(
    owns.trim().length <= OBJECTIVE_MAX,
    `owns line was ${owns.trim().length} characters, and its label counts too`
  );
});

test('dispatch states carry a glyph so outcome reads without scanning colours', () => {
  const text = lines(
    render({ records: [dispatch({ state: 'running' }), dispatch({ state: 'completed' }), dispatch({ state: 'error' })] })
  );
  assert.ok(text.some((line) => line.includes('●')));
  assert.ok(text.some((line) => line.includes('✓')));
  assert.ok(text.some((line) => line.includes('✗')));
});

test('a busy session is capped and says how much it is hiding', () => {
  const records = Array.from({ length: MAX_DISPATCH_ROWS + 4 }, (_, i) =>
    dispatch({ agent: `agent-${i}`, endedAt: i })
  );
  const text = lines(render({ records }));

  assert.equal(text.filter((line) => line.includes('agent-')).length, MAX_DISPATCH_ROWS);
  assert.ok(text.includes('+4 more'));
});

test('dispatch state is coloured by outcome, so a failure is not just more text', () => {
  const used = colors(
    render({
      records: [
        dispatch({ state: 'running', endedAt: undefined }),
        dispatch({ state: 'error' }),
        dispatch({ state: 'completed' }),
      ],
    })
  );

  assert.ok(used.includes('info'), 'running');
  assert.ok(used.includes('error'), 'failed');
  assert.ok(used.includes('success'), 'completed');
});

test('an unknown state still renders, in a neutral colour', () => {
  const tree = render({ records: [dispatch({ state: 'something-new' })] });
  assert.ok(lines(tree).includes('something-new'));
  assert.ok(colors(tree).every((color) => Object.values(THEME).includes(color)));
});

test('a record missing state renders "unknown", not the literal word undefined', () => {
  const tree = render({ records: [dispatch({ state: undefined })] });
  assert.ok(lines(tree).includes('unknown'));
  assert.ok(!lines(tree).some((line) => line.includes('undefined')));
});

// --------------------------------------------------------------------- theme

test('every colour comes from the theme, so the panel follows it', () => {
  const tree = render({
    version: '1.0.0',
    agents: [{ name: 'oracle', model: 'x/y' }],
    records: [dispatch({ state: 'running', owns: ['a/**'] }), dispatch()],
  });

  const themed = new Set(Object.values(THEME));
  for (const color of colors(tree)) {
    assert.ok(themed.has(color), `${color} is not a theme colour`);
  }
});

test('a theme missing a colour renders rather than crashing', () => {
  const text = lines(renderPanel({ theme: {}, records: [dispatch()] }, factory()));
  assert.ok(text.includes('Superagent'));
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
