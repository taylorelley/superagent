/**
 * Unit tests for the panel's activity derivation.
 *
 * The message shapes below are the ones OpenCode 2.2.5's TUI store holds —
 * captured from a live session (a `skill` call, then a foreground `subagent`
 * whose child ran `glob`) — trimmed to the fields the panel reads.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  activeSkill,
  childActivities,
  currentActivity,
  describeTool,
  findPlanPath,
  formatElapsed,
  mainActivity,
  planProgress,
  sessionData,
  sessionPlanPath,
} from '../../.opencode/lib/tui-activity.js';

const tool = (name, input, status = 'completed', created = 100) => ({
  type: 'tool',
  id: `call_${name}`,
  name,
  time: { created },
  state: { status, input },
});

const assistant = (content, { created = 50, completed = 60 } = {}) => ({
  type: 'assistant',
  agent: 'superagent',
  time: { created, ...(completed ? { completed } : {}) },
  content,
});

const MAIN = 'ses_main';
const CHILD = 'ses_child';

const store = ({ status = {}, info = {}, messages = {}, family = {} } = {}) => ({
  get: (id) => info[id] ?? null,
  family: (id) => family[id] ?? [id],
  status: (id) => status[id] ?? 'idle',
  messages: (id) => messages[id] ?? [],
});

/** The live session: skill loaded, foreground subagent running, child mid-glob. */
const live = () =>
  store({
    status: { [MAIN]: 'running', [CHILD]: 'running' },
    info: {
      [MAIN]: { title: 'Probe session', agent: 'superagent' },
      [CHILD]: { parentID: MAIN, title: 'Count files', agent: 'general' },
    },
    family: { [MAIN]: [MAIN, CHILD] },
    messages: {
      [MAIN]: [
        { type: 'user', time: { created: 1 }, content: [] },
        assistant([tool('skill', { id: 'brainstorming' })]),
        assistant(
          [
            tool(
              'subagent',
              { agent: 'general', description: 'Count files', prompt: '…' },
              'running',
              70,
            ),
          ],
          { created: 65, completed: null },
        ),
      ],
      [CHILD]: [
        { type: 'user', time: { created: 71 }, content: [] },
        assistant([tool('glob', { pattern: '*' }, 'running', 80)], {
          created: 75,
          completed: null,
        }),
      ],
    },
  });

// ------------------------------------------------------------- describeTool

test('describeTool names the tool and what it touches', () => {
  assert.equal(describeTool('edit', { filePath: '/repo/.opencode/lib/board.js' }), 'edit board.js');
  assert.equal(describeTool('read', { path: 'src/a.ts' }), 'read a.ts');
  assert.equal(describeTool('shell', { command: 'npm test\nmore' }), 'shell npm test');
  assert.equal(describeTool('glob', { pattern: '*' }), 'glob *');
  assert.equal(describeTool('subagent', { agent: 'general' }), 'subagent general');
  assert.equal(describeTool('skill', { id: 'brainstorming' }), 'skill brainstorming');
  assert.equal(describeTool('mystery', {}), 'mystery');
  assert.equal(describeTool('mystery', { filePath: '/a/b.md' }), 'mystery b.md');
  assert.equal(describeTool(undefined, null), 'tool');
});

// -------------------------------------------------------------- activity

test('the active skill is the newest skill tool call, or an activation message', () => {
  assert.equal(activeSkill(live().messages(MAIN)), 'brainstorming');
  assert.equal(activeSkill([{ type: 'skill', name: 'writing-plans' }]), 'writing-plans');
  assert.equal(
    activeSkill([assistant([tool('skill', { id: 'a' }), tool('skill', { id: 'b' })])]),
    'b',
  );
  assert.equal(activeSkill([assistant([tool('skill', { id: 'x' }, 'error')])]), null);
  assert.equal(activeSkill(undefined), null);
});

test('current activity is the newest live tool call, with when it started', () => {
  assert.deepEqual(currentActivity(live().messages(CHILD)), { label: 'glob *', since: 80 });
});

test('an open message with no live tool is thinking; a finished one is nothing', () => {
  assert.deepEqual(currentActivity([assistant([], { created: 5, completed: null })]), {
    label: 'thinking',
    since: 5,
  });
  assert.equal(currentActivity([assistant([tool('read', { path: 'a' })])]), null);
  assert.equal(currentActivity([]), null);
});

test('the main agent reports its skill and what it is waiting on', () => {
  assert.deepEqual(mainActivity(live(), MAIN), {
    state: 'running',
    skill: 'brainstorming',
    current: 'subagent general',
    since: 70,
  });
});

test('an idle main agent keeps its skill but reports no activity', () => {
  const data = live();
  const idle = { ...data, status: () => 'idle' };
  assert.deepEqual(mainActivity(idle, MAIN), {
    state: 'idle',
    skill: 'brainstorming',
    current: null,
    since: null,
  });
});

test('children are the direct subagent sessions, with what each is doing', () => {
  assert.deepEqual(childActivities(live(), MAIN), [
    {
      id: CHILD,
      agent: 'general',
      title: 'Count files',
      state: 'running',
      current: 'glob *',
      since: 80,
    },
  ]);
});

test('a grandchild is not reported as a child', () => {
  const data = store({
    family: { [MAIN]: [MAIN, CHILD, 'ses_grand'] },
    info: { [CHILD]: { parentID: MAIN }, ses_grand: { parentID: CHILD } },
  });
  assert.deepEqual(
    childActivities(data, MAIN).map((c) => c.id),
    [CHILD],
  );
});

test('missing data never throws', () => {
  assert.equal(mainActivity(null, MAIN), null);
  assert.equal(mainActivity(live(), null), null);
  assert.deepEqual(childActivities(null, MAIN), []);
  assert.deepEqual(childActivities({ ...live(), family: () => null }, MAIN), []);
});

test('sessionData adapts the host store and swallows its failures', () => {
  assert.equal(sessionData({}), null);
  const data = sessionData({
    data: {
      session: {
        get: () => ({ title: 't' }),
        family: () => {
          throw new Error('not loaded');
        },
        status: () => 'running',
        message: { list: () => undefined },
      },
    },
  });
  assert.deepEqual(data.get('x'), { title: 't' });
  assert.deepEqual(data.family('x'), []);
  assert.equal(data.status('x'), 'running');
  assert.deepEqual(data.messages('x'), []);
});

// ------------------------------------------------------------------- plan

test('the plan path is the newest plan file named in any tool input', () => {
  const messages = [
    assistant([tool('write', { filePath: '/repo/docs/superagent/plans/2026-01-01-old.md' })]),
    assistant([
      tool('subagent', {
        agent: 'implementer',
        prompt: 'Implement Task 3 from docs/superagent/plans/2026-11-02-panel.md.',
      }),
    ]),
  ];
  assert.equal(findPlanPath(messages), 'docs/superagent/plans/2026-11-02-panel.md');
  assert.equal(findPlanPath(messages.slice(0, 1)), '/repo/docs/superagent/plans/2026-01-01-old.md');
  assert.equal(findPlanPath([assistant([tool('read', { filePath: 'docs/other.md' })])]), null);
  assert.equal(findPlanPath(undefined), null);
});

const PLAN = `# Panel Implementation Plan

### Task 1: Activity module

- [x] **Step 1: Write the failing test**
- [x] **Step 2: Implement**

### Task 2: Export conflicts

- [x] **Step 1: Write the failing test**
- [ ] **Step 2: Implement**

### Task 3: Docs

- [ ] **Step 1: Update docs**
`;

test('plan progress counts ticked steps and names the task holding the next one', () => {
  assert.deepEqual(planProgress(PLAN), {
    done: 3,
    total: 5,
    current: 'Task 2: Export conflicts',
    unit: 'steps',
  });
});

test('a plan with no checkboxes still reports its task count', () => {
  assert.deepEqual(planProgress('## Task 1: A\n\n## Task 2: B\n'), {
    done: 0,
    total: 2,
    current: 'Task 1: A',
    unit: 'tasks',
  });
  assert.equal(planProgress('just prose'), null);
  assert.equal(planProgress(undefined), null);
});

test('a finished plan has no current task', () => {
  assert.equal(planProgress(PLAN.replaceAll('[ ]', '[x]')).current, null);
});

// ------------------------------------------------------------------ time

test('formatElapsed reads like a stopwatch', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(42_000), '0:42');
  assert.equal(formatElapsed(12 * 60_000 + 5_000), '12:05');
  assert.equal(formatElapsed(3_723_000), '1:02:03');
  assert.equal(formatElapsed(-1), '');
  assert.equal(formatElapsed(undefined), '');
});

test('a running session between tool calls is thinking, not blank', () => {
  const data = store({
    status: { [MAIN]: 'running' },
    messages: {
      [MAIN]: [assistant([tool('read', { path: 'a.js' })], { created: 5, completed: 9 })],
    },
  });
  assert.deepEqual(mainActivity(data, MAIN), {
    state: 'running',
    skill: null,
    current: 'thinking',
    since: 9,
  });
});

test("a plan written by a subagent is found from the parent's session", () => {
  const data = store({
    family: { [MAIN]: [MAIN, CHILD] },
    info: { [CHILD]: { parentID: MAIN } },
    messages: {
      [MAIN]: [assistant([tool('subagent', { agent: 'planner', prompt: 'Write the plan.' })])],
      [CHILD]: [assistant([tool('write', { path: 'docs/superagent/plans/p.md', content: '…' })])],
    },
  });
  assert.equal(sessionPlanPath(data, MAIN), 'docs/superagent/plans/p.md');
  assert.equal(sessionPlanPath(data, null), null);
  assert.equal(sessionPlanPath(null, MAIN), null);
});
