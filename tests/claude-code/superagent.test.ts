/**
 * The Claude Code hooks module, driven through Claude Code's own test kit
 * (`claude plugin test`): every event below is raised by the engine's `$`, the
 * plugin's hooks run on it, and the test's own hooks sit beneath them where the
 * engine would be.
 *
 * The kit has no filesystem, so the files the plugin reads are answered from
 * memory (`files` below): short stand-ins for the skill, the prompt templates
 * and the config, shaped like the real ones. The real templates are checked
 * against the same extraction by tests/claude-code/test-claude-code.mjs.
 */

import { describe, expect, mock, test } from 'claude-code/testing';

const ROOT_MARK = '/.claude-plugin/plugin.json';

const template = (role: string) =>
  [
    `# ${role} Prompt Template`,
    '',
    '```',
    'Subagent (general-purpose):',
    '  description: "Do the job"',
    '  prompt: |',
    `    You are the ${role}.`,
    '```',
    '',
  ].join('\n');

const baseFiles: Record<string, string> = {
  [ROOT_MARK]: JSON.stringify({ name: 'superagent', version: '9.9.9' }),
  '/skills/using-superagent/SKILL.md': '---\nname: using-superagent\n---\nUSE THE SKILLS FIRST.',
  '/.opencode/prompts/orchestrator.md': 'You are the Superagent orchestrator.',
  '/.opencode/prompts/oracle.md': 'You are the oracle.',
  '/.opencode/prompts/librarian.md': 'You are the librarian.',
  '/skills/subagent-driven-development/implementer-prompt.md': template('implementer'),
  '/skills/subagent-driven-development/task-reviewer-prompt.md': template('task reviewer'),
  '/skills/subagent-driven-development/re-review-prompt.md': template('re-reviewer'),
  '/skills/requesting-code-review/code-reviewer.md': template('code reviewer'),
  '/skills/brainstorming/spec-document-reviewer-prompt.md': template('spec reviewer'),
  '/skills/writing-plans/plan-document-reviewer-prompt.md': template('plan reviewer'),
};

type Written = Record<string, string>;

/** Answer the plugin's file reads from memory; `extra` keys are full paths or suffixes. */
const files = (on: any, extra: Record<string, string> = {}, written: Written = {}) => {
  const table = { ...baseFiles, ...extra };
  const lookup = (path: string) => {
    if (path in written) return written[path];
    if (path in table) return table[path];
    const hit = Object.keys(table).find((key) => key.startsWith('/') && path.endsWith(key));
    return hit === undefined ? undefined : table[hit];
  };
  on('fs.read', ($: any, e: any) => {
    const text = lookup(e.path);
    if (text === undefined) return { deny: `ENOENT: ${e.path}` };
    return { value: text };
  });
  on('fs.exists', ($: any, e: any) => ({ value: lookup(e.path) !== undefined }));
  on('fs.write', ($: any, e: any) => {
    written[e.path] = e.text;
    return { value: undefined };
  });
};

/** What the engine answers beneath the plugin; returns the lines it logged. */
const engine = (on: any, { clock = true } = {}) => {
  const logs: string[] = [];
  on('session.start', ($: any, e: any) => ({ cwd: e.cwd }));
  on('turn.start', ($: any, e: any) => ({ turnId: e.turnId }));
  on('turn.complete', () => ({ text: '' }));
  on('ui.log', ($: any, e: any) => {
    logs.push(e.text);
    return { value: undefined };
  });
  on('ui.toast', () => ({ value: undefined }));
  on('ui.open', () => ({ value: { isPlaced: true } }));
  on('ui.close', () => ({ value: undefined }));
  on('command.list', () => ({ value: [] }));
  on('command.register', () => ({ value: undefined }));
  on('settings.read', () => ({ value: {} }));
  if (clock) on('clock.every', () => ({ value: undefined }));
  on('session.cwd', () => ({ value: '/work/project' }));
  on('http.fetch', () => ({ value: { status: 404, ok: false, headers: {}, text: '' } }));
  return logs;
};

const start = async ($: any) => {
  await $.session.start({ cwd: '/work/project', surface: 'terminal', isInteractive: false });
};

const env = { HOME: '/home/tester' };

describe('roster', () => {
  test('registers the specialists as superagent:<name> agent types', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on);
    const registered: any[] = [];
    on('agent.register', ($: any, e: any) => {
      registered.push(e);
      return { value: { agent: `superagent:${e.name}` } };
    });
    await start($);

    const names = registered.map((r) => r.name).sort();
    expect(names).toEqual([
      'code-reviewer',
      'implementer',
      'implementer-deep',
      'librarian',
      'oracle',
      'plan-reviewer',
      're-reviewer',
      'spec-reviewer',
      'task-reviewer',
    ]);
    const implementer = registered.find((r) => r.name === 'implementer');
    expect(implementer.disallowedTools).toEqual(['Agent']);
    expect(implementer.prompt).toContain('SUPERAGENT_CONTRACT');
    expect(implementer.prompt).toContain('You are the implementer.');
    expect(implementer.model).toBeUndefined();
    const oracle = registered.find((r) => r.name === 'oracle');
    expect(oracle.disallowedTools).toEqual(['Edit', 'Write', 'NotebookEdit', 'Agent']);
  });

  test('routes slots to Claude models and drops others', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on, {
      '/home/tester/.claude/superagent.json': JSON.stringify({
        agents: {
          models: {
            implementer: 'haiku',
            deepReviewer: 'anthropic/claude-opus-5-5#high',
            oracle: 'openai/gpt-5',
          },
        },
      }),
    });
    const registered: any[] = [];
    on('agent.register', ($: any, e: any) => {
      registered.push(e);
      return { value: { agent: `superagent:${e.name}` } };
    });
    await start($);
    const by = (name: string) => registered.find((r) => r.name === name);
    expect(by('implementer').model).toBe('haiku');
    expect(by('code-reviewer').model).toBe('claude-opus-5-5');
    expect(by('code-reviewer').effort).toBe('high');
    expect(by('oracle').model).toBeUndefined();
  });

  test('the solo preset registers no agents and withholds earlier ones', async ($, on) => {
    mock.env(on, { ...env, SUPERAGENT_PRESET: 'solo' });
    engine(on);
    mock.store(on);
    files(on);
    const registered: any[] = [];
    on('agent.register', ($: any, e: any) => {
      registered.push(e);
      return { value: { agent: `superagent:${e.name}` } };
    });
    await start($);
    expect(registered).toEqual([]);
    const offered = await $.agent.offer({
      agent: 'superagent:implementer',
      description: 'x',
      source: 'plugin',
      provider: { plugin: 'superagent', tier: 'user' },
    } as any);
    expect(offered.isOffered).toBe(false);
  });
});

describe('main thread', () => {
  test('the bootstrap and routing table ride the first message', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    on('prompt.context', () => ({ blocks: [{ name: 'currentDate', text: 'today' }] }));
    await start($);
    const context = await $.prompt.context({ blocks: [] } as any);
    const block = context.blocks.find((b: any) => b.name === 'superagent');
    expect(block).toBeDefined();
    expect(block!.text).toContain('USE THE SKILLS FIRST.');
    expect(block!.text).toContain('Tool Mapping for Claude Code');
    expect(block!.text).toContain('`superagent:implementer`');
    expect(block!.text).toContain('run_in_background: true');
  });

  test('the orchestrator role is added to the system prompt', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'core', scope: 'shared' }] }));
    await start($);
    const composed = await $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: [],
      tools: [],
      outputStyle: null,
      traits: [],
    } as any);
    const section = composed.sections.find((s: any) => s.id === 'superagent:orchestrator');
    expect(section?.text).toContain('You are the Superagent orchestrator.');
  });

  test('the orchestrator may write only under .superagent/', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    on('tool.check', () => ({ decision: 'allow' }));
    await start($);
    const outside = await $.tool.check({
      tool: 'Edit',
      input: { file_path: '/work/project/src/app.js', old_string: 'a', new_string: 'b' },
    } as any);
    expect(outside.decision).toBe('deny');
    const inside = await $.tool.check({
      tool: 'Write',
      input: { file_path: '/work/project/.superagent/plan.md', content: 'x' },
    } as any);
    expect(inside.decision).toBe('allow');
    const shell = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } } as any);
    expect(shell.decision).toBe('allow');
  });

  test('setDefaultAgent: false leaves the main thread alone', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on, {
      '/work/project/.claude/superagent.json': JSON.stringify({
        agents: { setDefaultAgent: false },
      }),
    });
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    on('tool.check', () => ({ decision: 'allow' }));
    await start($);
    const outside = await $.tool.check({
      tool: 'Edit',
      input: { file_path: '/work/project/src/app.js', old_string: 'a', new_string: 'b' },
    } as any);
    expect(outside.decision).toBe('allow');
  });
});

describe('when another plugin runs first', () => {
  // Claude Code's built-in security default passes prompt.compose and
  // prompt.context by in Team and Enterprise organisations. Here that is the
  // test raising neither before the main thread's first request.
  const routedToHaiku = {
    '/home/tester/.claude/superagent.json': JSON.stringify({
      agents: { models: { orchestrator: 'haiku' } },
    }),
  };

  /** The engine beneath turn.step; returns the models the requests named. */
  const steps = (on: any, turns: number) => {
    const models: string[] = [];
    on('session.turns', () => ({ value: turns }));
    on('turn.step', async function* ($: any, e: any) {
      models.push(e.model);
      return { turnId: e.turnId, index: e.index, answer: '', toolUses: [] };
    });
    return models;
  };

  const firstRequest = async ($: any) => {
    const stream = $.turn.step({
      turnId: 'turn-1',
      index: 0,
      model: 'claude-opus-5-5',
      messageCount: 15,
    } as any);
    for await (const _ of stream) {
      // drain
    }
  };

  const composeAndContext = async ($: any) => {
    await $.prompt.compose({
      model: 'claude-opus-5-5',
      promptModel: 'claude-opus-5-5',
      surfaces: [],
      tools: [],
      outputStyle: null,
      traits: [],
    } as any);
    await $.prompt.context({ blocks: [] } as any);
  };

  const editOutside = ($: any) =>
    $.tool.check({
      tool: 'Edit',
      input: { file_path: '/work/project/src/app.js', old_string: 'a', new_string: 'b' },
    } as any);

  const setup = (on: any, turns: number) => {
    mock.env(on, env);
    const logs = engine(on);
    mock.store(on);
    files(on, routedToHaiku);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'core', scope: 'shared' }] }));
    on('prompt.context', () => ({ blocks: [] }));
    on('tool.check', () => ({ decision: 'allow' }));
    return { logs, models: steps(on, turns) };
  };

  test('passed by: says so, and drops the orchestrator model and write guard', async ($, on) => {
    const { logs, models } = setup(on, 1);
    await start($);
    expect((await editOutside($)).decision).toBe('deny');
    await firstRequest($);

    const notice = logs.find((l) => l.includes('Another plugin that runs before Superagent'));
    expect(notice).toContain('the orchestrator role and the session bootstrap');
    expect(notice).toContain('/superagent:using-superagent');
    expect(models).toEqual(['claude-opus-5-5']);
    expect((await editOutside($)).decision).toBe('allow');

    // Later requests stay plain, and the notice is not repeated.
    const again = $.turn.step({
      turnId: 'turn-1',
      index: 1,
      model: 'claude-opus-5-5',
      messageCount: 17,
    } as any);
    for await (const _ of again) {
      // drain
    }
    expect(models).toEqual(['claude-opus-5-5', 'claude-opus-5-5']);
    expect(logs.filter((l) => l.includes('Another plugin')).length).toBe(1);
  });

  test('hooks ran: no notice, the role keeps its model and guard', async ($, on) => {
    const { logs, models } = setup(on, 1);
    await start($);
    await composeAndContext($);
    await firstRequest($);
    expect(logs.some((l) => l.includes('Another plugin'))).toBe(false);
    expect(models).toEqual(['haiku']);
    expect((await editOutside($)).decision).toBe('deny');
  });

  test('a reloaded or resumed session is not judged', async ($, on) => {
    const { logs, models } = setup(on, 4);
    await start($);
    await firstRequest($);
    expect(logs.some((l) => l.includes('Another plugin'))).toBe(false);
    expect(models).toEqual(['haiku']);
    expect((await editOutside($)).decision).toBe('deny');
  });

  test('the panel and /preset show it', async ($, on) => {
    setup(on, 1);
    await start($);
    await firstRequest($);
    const shown = await $.command.run({ command: 'preset', args: '' } as any);
    expect(shown.text).toContain('⚠ orchestrator off: org policy');
    const ui = await $.ui.mount({
      plugin: 'superagent',
      surface: 'terminal',
      component: 'Pane',
      requestId: 'superagent',
      props: { title: 'Superagent', isFocused: false, bodyColumns: 44 } as any,
    });
    expect(await ui.find({ type: 'Text', text: /orchestrator off: org policy/ })).toBeDefined();
    expect(await ui.find({ type: 'Text', text: /superagent \(main\)/ })).toBeUndefined();
    await ui.unmount();
  });
});

describe('job board', () => {
  test('a dispatch overlapping a running write claim is told so', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    const prompts: string[] = [];
    let n = 0;
    on('agent.spawn', ($: any, e: any) => {
      prompts.push(e.prompt);
      n += 1;
      return { model: 'claude-haiku-5-5', agentId: `agent-${n}` };
    });
    await start($);
    const spawn = (id: string, prompt: string) =>
      $.agent.spawn({
        tool_use_id: id,
        prompt,
        description: `task ${id}`,
        subagentType: 'superagent:implementer',
        provider: { plugin: 'superagent', tier: 'user' },
        parentModel: 'claude-opus-5-5',
        background: true,
        fork: false,
      } as any);

    await spawn('t1', 'Do A\n<!-- superagent-ownership: write=src/api/** -->');
    await spawn('t2', 'Do B\n<!-- superagent-ownership: write=src/api/users.js -->');
    expect(prompts[0]).not.toContain('SUPERAGENT_OWNERSHIP_CONFLICT');
    expect(prompts[1]).toContain('SUPERAGENT_OWNERSHIP_CONFLICT');

    const board = await $.command.run({ command: 'board', args: '' } as any);
    expect(board.text).toContain('Dispatched this session: 2 (2 still running)');

    await $.turn.complete({
      agentId: 'agent-1',
      answer: 'Implemented A.',
      reason: 'answer',
      durationMs: 5,
      isAborted: false,
      turnId: 'x',
    } as any);
    const after = await $.command.run({ command: 'board', args: '' } as any);
    expect(after.text).toContain('(1 still running)');
    expect(after.text).toContain('completed');
  });

  test('the board rides the next prompt', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }));
    let seen: readonly string[] | undefined;
    on('prompt.submit', ($: any, e: any) => {
      seen = e.context;
      return { text: e.text };
    });
    await start($);
    await $.agent.spawn({
      tool_use_id: 't1',
      prompt: 'Do A',
      description: 'task A',
      subagentType: 'superagent:implementer',
      provider: { plugin: 'superagent', tier: 'user' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    } as any);
    await $.prompt.submit({ text: 'what is running?' } as any);
    expect(seen?.[0]).toContain('<SUPERAGENT_JOB_BOARD>');
  });

  test('a reviewer may not edit, by tool.check as well as by withholding', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'rev-1' }));
    on('tool.check', () => ({ decision: 'allow' }));
    await start($);
    await $.agent.spawn({
      tool_use_id: 't9',
      prompt: 'Review',
      description: 'review',
      subagentType: 'superagent:task-reviewer',
      provider: { plugin: 'superagent', tier: 'user' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    } as any);
    const verdict = await $.tool.check({
      tool: 'Edit',
      input: { file_path: 'src/a.js', old_string: 'a', new_string: 'b' },
      agentId: 'rev-1',
    } as any);
    expect(verdict.decision).toBe('deny');
  });
});

describe('commands', () => {
  test('/preset shows the active preset', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    await start($);
    const shown = await $.command.run({ command: 'preset', args: '' } as any);
    expect(shown.text).toContain('Active preset: team');
  });

  test('/preset solo --persist saves the state file and withholds the roster', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    const written: Written = {};
    files(on, {}, written);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    on('tool.check', () => ({ decision: 'allow' }));
    await start($);
    const answer = await $.command.run({ command: 'preset', args: 'solo --persist' } as any);
    expect(answer.text).toContain('Preset "solo" saved');
    expect(JSON.parse(written['/home/tester/.claude/superagent.state.json'])).toEqual({
      preset: 'solo',
    });
    const offered = await $.agent.offer({
      agent: 'superagent:implementer',
      description: 'x',
      source: 'plugin',
      provider: { plugin: 'superagent', tier: 'user' },
    } as any);
    expect(offered.isOffered).toBe(false);
    // The session keeps the role it started with, guard included.
    const guarded = await $.tool.check({
      tool: 'Edit',
      input: { file_path: '/work/project/src/app.js', old_string: 'a', new_string: 'b' },
    } as any);
    expect(guarded.decision).toBe('deny');
    // A command the new preset switches off says so.
    const board = await $.command.run({ command: 'board', args: '' } as any);
    expect(board.text).toContain('/board is off in the current Superagent preset (solo)');
  });

  test('/council explains itself when it is not configured', async ($, on) => {
    mock.env(on, { ...env, SUPERAGENT_PRESET: 'council' });
    engine(on);
    mock.store(on);
    files(on);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    await start($);
    const answer = await $.command.run({ command: 'council', args: 'is X wise?' } as any);
    expect(answer.text).toContain('at least two members');
  });

  test('/council registers sealed councillors and submits the instruction', async ($, on) => {
    mock.env(on, env);
    engine(on, { clock: false });
    const clock = mock.clock(on);
    mock.store(on);
    files(on, {
      '/home/tester/.claude/superagent.json': JSON.stringify({
        preset: 'council',
        council: {
          members: [
            { name: 'alpha', model: 'opus' },
            { name: 'beta', model: 'sonnet' },
          ],
        },
      }),
    });
    const registered: any[] = [];
    on('agent.register', ($: any, e: any) => {
      registered.push(e);
      return { value: { agent: `superagent:${e.name}` } };
    });
    let submitted = '';
    on('prompt.submit', ($: any, e: any) => {
      submitted = e.text;
      return { text: e.text };
    });
    await start($);
    const alpha = registered.find((r) => r.name === 'councillor-alpha');
    expect(alpha.model).toBe('opus');
    expect(alpha.disallowedTools).toEqual([
      'Edit',
      'Write',
      'NotebookEdit',
      'Agent',
      'Bash',
      'PowerShell',
    ]);
    const answer = await $.command.run({ command: 'council', args: 'is X wise?' } as any);
    expect(answer.text).toContain('superagent:councillor-alpha');
    // The instruction is submitted just after the command returns.
    await clock.advance(1);
    expect(submitted).toContain('<SUPERAGENT_COUNCIL>');
    expect(submitted).toContain('subagent_type: `superagent:councillor-beta`');
  });

  test('/update reports the cached check', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on, {
      'update-check': {
        checkedAt: 1,
        currentVersion: '9.9.9',
        latestVersion: '9.9.10',
        updateAvailable: true,
      },
    });
    files(on);
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    await start($);
    const answer = await $.command.run({ command: 'update', args: '' } as any);
    expect(answer.text).toContain('Latest known version: 9.9.10');
    expect(answer.text).toContain('/update install');
  });
});

describe('panel', () => {
  test('draws the plan, the main thread, the subagents and the footer', async ($, on) => {
    mock.env(on, env);
    engine(on);
    mock.store(on);
    files(on, {
      '/work/project/docs/superagent/plans/2026-11-03-demo.md':
        '# Plan\n\n### Task 1: One\n- [x] a\n### Task 2: Two\n- [ ] b\n',
    });
    on('agent.register', ($: any, e: any) => ({ value: { agent: `superagent:${e.name}` } }));
    on('agent.spawn', () => ({ model: 'haiku', agentId: 'agent-1' }));
    on('tool.call', () => ({ result: 'ok' }));
    await start($);
    await $.agent.spawn({
      tool_use_id: 't1',
      prompt: 'Do A\n<!-- superagent-ownership: write=src/api/** -->',
      description: 'Count files',
      subagentType: 'superagent:implementer',
      provider: { plugin: 'superagent', tier: 'user' },
      parentModel: 'claude-opus-5-5',
      background: true,
      fork: false,
    } as any);
    await $.tool.call({
      tool: 'Read',
      file_path: 'docs/superagent/plans/2026-11-03-demo.md',
    } as any);

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'superagent',
        surface,
        component: 'Pane',
        requestId: 'superagent',
        props: { title: 'Superagent', isFocused: false, bodyColumns: 44 } as any,
      });
      expect(await ui.find({ type: 'Text', text: /^Plan$/ })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /2026-11-03-demo\.md/ })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /Task 2: Two/ })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /superagent:implementer · Count/ })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /owns src\/api\/\*\*/ })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /^Superagent$/ })).toBeDefined();
      const footer = await ui.find({ type: 'Button', text: /Superagent/ });
      expect(footer?.text).toMatch(/v9\.9\.9 +team · 10 agents$/);
      // Pressing the footer shows the roster, routed slots first, the rest as inherit.
      await ui.press({ key: footer!.key! } as any);
      expect(await ui.find({ type: 'Text', text: /superagent:implementer-deep/ })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /^inherit$/ })).toBeDefined();
      expect(await ui.find({ type: 'Text', text: /superagent:oracle/ })).toBeUndefined();
      const more = await ui.find({ type: 'Button', text: /\+2 more/ });
      await ui.press({ key: more!.key! } as any);
      expect(await ui.find({ type: 'Text', text: /superagent:oracle/ })).toBeDefined();
      await ui.press({ key: footer!.key! } as any);
      await ui.unmount();
    }
  });
});
