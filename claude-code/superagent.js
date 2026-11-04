/**
 * Superagent for Claude Code: the hooks module (a "mod").
 *
 * The same agent team as the OpenCode plugin, on Claude Code's mods API:
 *
 * | Superagent feature | OpenCode 2 | Claude Code (this file) |
 * |---|---|---|
 * | skills | `ctx.skill.transform` | the plugin's `skills/` folder, loaded natively |
 * | specialist roster, council | `ctx.agent.transform` | `$.agent.register` at `session.start` |
 * | orchestrator as default agent | `editor.default(...)` | its prompt added to the main thread's system prompt (`prompt.compose`), its model at `turn.step` |
 * | per-agent permissions | agent permission rules | withheld tools, plus `tool.check` for path- and pattern-scoped rules |
 * | bootstrap + routing table | session `context` hook | `prompt.context` |
 * | job board | `context` hook | `prompt.submit` context |
 * | dispatch tracking, ownership | `subagent` `execute.before/after` | `agent.spawn` (rewrites the prompt), `turn.start`/`turn.complete` |
 * | `/board` `/preset` `/update` `/council` | command transform | `$.command.register` + `command.run` |
 * | sidebar panel | TUI `sidebar.content` slot | a pane (`ui.render` for `Pane`) |
 * | update check | `fetch` + cache file | `$.http.fetch` + `$.store` |
 *
 * A plugin that runs first may pass `prompt.compose` and `prompt.context` by
 * (Claude Code's built-in security default does, for Team and Enterprise
 * organisations). `./lib/fallback.js` says how that is noticed; the session
 * then drops the orchestrator's model and guard, and tells the person.
 *
 * All behaviour that does not need the mods API lives in `../core/`, shared
 * with OpenCode, and `./lib/`, pure translations for Claude Code. This file
 * holds every `$` call, because a hooks module may only call the mods API from
 * its own file. Every hook is guarded: a throw is logged and the event passes
 * through unchanged, so Superagent failing never takes a session down.
 */

import { configureLog } from '../core/log.js';
import { parseConfigText, resolveSettings } from '../core/config.js';
import { usableMembers, councilInstruction } from '../core/council.js';
import { renderBootstrap } from '../core/bootstrap.js';
import { renderRoutingTable, renderConflicts } from '../core/routing.js';
import * as board from '../core/board.js';
import { commandsToRegister } from '../core/commands.js';
import { describeTool, planProgress, PLAN_PATTERN } from '../core/activity.js';
import { updateResult, isFresh, LATEST_RELEASE_URL, PACKAGE_JSON_URL } from '../core/versions.js';
import { buildRoster, buildCouncil, promptPaths } from './lib/roster.js';
import { checkCall } from './lib/tools.js';
import { claudeConfigDir, configFiles, pluginFile } from './lib/paths.js';
import {
  presetCommand,
  presetSavedText,
  boardText,
  updateText,
  updatePlan,
  installText,
  councilUnavailableText,
} from './lib/commands.js';
import { drawPanel } from './lib/panel.js';
import {
  isFirstRequest,
  judgeHostHooks,
  isBlocked,
  fallbackNotice,
  fallbackLine,
} from './lib/fallback.js';

/** The main conversation, as a board session key. */
const MAIN = 'main';
const PANE = 'superagent';
const UPDATE_KEY = 'update-check';
const PANEL_COMMAND = 'superagent';

/** Everything the hooks share. Hooks of one mod share the variables of its file. */
const state = {
  pluginName: 'superagent',
  root: '',
  cwd: '',
  env: {},
  configDir: null,
  files: {},
  settings: null,
  version: 'dev',
  prompts: {},
  skillText: null,
  roster: { specs: [], registered: [], orchestrator: null, rules: {}, warnings: [] },
  council: { specs: [], registered: [], rules: {}, warnings: [] },
  /** Our agent types offered right now; one left out by a preset is withheld. */
  active: new Set(),
  rules: {},
  orchestrator: null,
  /**
   * The main thread's role as this session started with it. A preset applied
   * mid-session changes what new dispatches get, but the session keeps its
   * role, its guard and its model, as an OpenCode session keeps its agent.
   */
  sessionRole: undefined,
  bootstrap: null,
  conflicts: [],
  commands: new Set(),
  registeredOnce: false,
  agentTypes: new Map(),
  main: { running: false, current: null, since: null, skill: null },
  children: new Map(),
  plan: { path: null, progress: null },
  update: null,
  updateChecked: false,
  ui: {
    agentsExpanded: false,
    agentRowLimit: 8,
    dispatchRowLimit: 5,
    open: false,
  },
  lastBoard: null,
  /** Which prompt hooks ran in this module's lifetime. */
  hostHooks: { compose: false, context: false },
  /** What a plugin that runs first passed by: null until judged. */
  blocked: null,
  spawnSeq: 0,
  ticking: false,
};

// `core/` logs through this sink; the queue is flushed by the next hook, which
// is the only place `$.ui.log` may be called from.
const logQueue = [];
const logged = new Set();
configureLog({
  prefix: '[superagent/claude-code]',
  sink: (level, args) =>
    logQueue.push({
      level,
      text: args.map((a) => (a instanceof Error ? a.message : String(a))).join(' '),
    }),
  debug: () => state.env.SUPERAGENT_DEBUG === '1' || state.env.SUPERAGENT_DEBUG === 'true',
});

const isEnabled = (section) => state.settings?.[section]?.enabled !== false;

/**
 * The main thread's role as it actually applies: none when its system prompt
 * section was passed by, so its model and write guard are not imposed on a
 * conversation that was never told it is the orchestrator.
 */
const mainRole = () => (state.blocked?.role ? null : state.sessionRole);

/** Judge, once, on the main thread's first request, whether our prompt hooks ran. */
async function judgeHostHooksOnce($, step) {
  if (state.blocked !== null || step.agentId) return;
  state.blocked = { role: false, bootstrap: false };
  let turns;
  try {
    turns = await $.session.turns();
  } catch {
    turns = undefined;
  }
  // A reloaded or resumed session: the hooks need not run again, so no verdict.
  if (!isFirstRequest(step, turns)) return;
  state.blocked = judgeHostHooks({
    seen: state.hostHooks,
    wantRole: Boolean(state.sessionRole),
    wantBootstrap: Boolean(state.bootstrap),
  });
  logQueue.push({
    level: 'debug',
    text: `prompt hooks seen ${JSON.stringify(state.hostHooks)}; passed by ${JSON.stringify(state.blocked)}`,
  });
  if (isBlocked(state.blocked)) {
    logQueue.push({ level: 'warn', text: fallbackNotice(state.blocked, state) });
    $.ui.invalidate('ui.render');
  }
  flushLog($);
}

/** Write queued log lines: warnings once each to the transcript, debug to the debug log. */
function flushLog($) {
  while (logQueue.length) {
    const { level, text } = logQueue.shift();
    if (level === 'debug') {
      $.ui.log(`superagent: ${text}`, { to: 'debug' });
      continue;
    }
    if (logged.has(text)) continue;
    logged.add(text);
    $.ui.log(`superagent: ${text}`);
  }
}

/** A file's text, or null when it cannot be read. */
async function readText($, file) {
  if (!file) return null;
  try {
    return await $.fs.read(file);
  } catch {
    return null;
  }
}

/** A config file and its `.jsonc` spelling, parsed; null when neither exists. */
async function readConfig($, file) {
  for (const candidate of file ? [file, `${file}c`] : []) {
    const text = await readText($, candidate);
    if (text !== null) return parseConfigText(text, candidate);
  }
  return null;
}

/** Read the environment, the config layers, the prompts and the version. */
async function load($, cwd) {
  state.pluginName = $.plugin.name || 'superagent';
  state.root = $.plugin.root;
  state.cwd = cwd || (await $.session.cwd());

  // Each read is spelled out: a hooks module's environment reads are listed
  // by `claude plugin validate`, so they must be literal.
  const read = {
    HOME: await $.env.get('HOME'),
    USERPROFILE: await $.env.get('USERPROFILE'),
    CLAUDE_CONFIG_DIR: await $.env.get('CLAUDE_CONFIG_DIR'),
    SUPERAGENT_PRESET: await $.env.get('SUPERAGENT_PRESET'),
    SUPERAGENT_DISABLE: await $.env.get('SUPERAGENT_DISABLE'),
    SUPERAGENT_DEBUG: await $.env.get('SUPERAGENT_DEBUG'),
  };
  const env = Object.fromEntries(Object.entries(read).filter(([, v]) => typeof v === 'string'));
  state.env = env;
  state.configDir = claudeConfigDir(env);
  state.files = configFiles({ configDir: state.configDir, projectDir: state.cwd });

  state.settings = resolveSettings({
    userFile: await readConfig($, state.files.user),
    projectFile: await readConfig($, state.files.project),
    stateFile: await readConfig($, state.files.state),
    env,
  });

  const manifest = await readText($, pluginFile(state.root, '.claude-plugin/plugin.json'));
  try {
    state.version = JSON.parse(manifest ?? '{}').version || 'dev';
  } catch {
    state.version = 'dev';
  }

  if (!Object.keys(state.prompts).length) {
    for (const relative of promptPaths()) {
      state.prompts[relative] = await readText($, pluginFile(state.root, relative));
    }
    state.skillText = await readText($, pluginFile(state.root, 'skills/using-superagent/SKILL.md'));
  }
}

/**
 * Register the roster and council for the current settings, and work out the
 * main thread's role. Re-registering a name replaces it; a name the settings
 * no longer want is withheld at `agent.offer`.
 */
async function registerAgents($) {
  const settings = state.settings;
  const members = usableMembers(settings.council);
  state.roster = buildRoster(settings, state.prompts, { pluginName: state.pluginName });
  state.council = buildCouncil(settings, members, { pluginName: state.pluginName });

  const active = new Set();
  for (const spec of [...state.roster.specs, ...state.council.specs]) {
    try {
      const { agent } = await $.agent.register(spec);
      active.add(agent ?? `${state.pluginName}:${spec.name}`);
    } catch (err) {
      logQueue.push({ level: 'warn', text: `could not register agent ${spec.name}: ${err}` });
    }
  }
  state.active = active;
  state.rules = { ...state.roster.rules, ...state.council.rules };
  state.registeredOnce = true;
  for (const text of [...state.roster.warnings, ...state.council.warnings]) {
    logQueue.push({ level: 'warn', text });
  }

  // The orchestrator is the main thread's role, as it is OpenCode's default
  // agent — unless the person chose a main-thread agent of their own.
  let userAgent;
  try {
    userAgent = (await $.settings.read())?.agent ?? null;
  } catch {
    userAgent = null;
  }
  state.orchestrator =
    state.roster.orchestrator && settings.agents.setDefaultAgent !== false && !userAgent
      ? state.roster.orchestrator
      : null;
}

/** Register the slash commands this preset offers, skipping names already taken. */
async function registerCommands($) {
  let existing;
  try {
    existing = new Set(
      (await $.command.list()).filter((c) => c.plugin !== state.pluginName).map((c) => c.name),
    );
  } catch {
    existing = new Set();
  }
  const { commands, conflicts } = commandsToRegister(state.settings, existing);
  const wanted = [...commands];
  if (isEnabled('tui')) {
    if (existing.has(PANEL_COMMAND)) conflicts.push({ kind: 'command', name: PANEL_COMMAND });
    else
      wanted.push({
        name: PANEL_COMMAND,
        description: 'Show or hide the Superagent panel',
      });
  }
  for (const { name, description } of wanted) {
    if (state.commands.has(name)) continue;
    try {
      await $.command.register({
        name,
        description,
        ...(name === 'council' ? { argumentHint: '<question>' } : {}),
        ...(name === 'preset' ? { argumentHint: '[name] [--persist]' } : {}),
        ...(name === 'update' ? { argumentHint: '[install]' } : {}),
        ...(name === 'board' || name === PANEL_COMMAND ? { immediate: true } : {}),
      });
      state.commands.add(name);
    } catch (err) {
      logQueue.push({ level: 'warn', text: `could not register /${name}: ${err}` });
    }
  }
  state.offeredCommands = new Set(wanted.map((c) => c.name));
  state.conflicts = conflicts;
}

/** The bootstrap block: `using-superagent`, the tool map, the routing table. */
function buildBootstrap() {
  if (!isEnabled('bootstrap') || !state.skillText) {
    state.bootstrap = null;
    return;
  }
  const registered = [
    ...state.roster.registered,
    // Councillors are dispatched by `/council`, not routed to.
  ];
  const extra = [
    registered.length ? renderRoutingTable(registered, { host: 'claude' }) : '',
    renderConflicts(state.conflicts, { host: 'claude' }),
  ]
    .filter(Boolean)
    .join('\n\n');
  state.bootstrap = renderBootstrap(state.skillText, { host: 'claude', extra });
}

async function setup($, cwd) {
  await load($, cwd);
  await registerAgents($);
  await registerCommands($);
  buildBootstrap();
}

/** Re-read the plan file the session is working from. */
async function refreshPlan($) {
  if (!state.plan.path) return;
  const file = /^([A-Za-z]:)?[\\/]/.test(state.plan.path)
    ? state.plan.path
    : `${state.cwd}/${state.plan.path}`;
  const text = await readText($, file);
  state.plan.progress = text === null ? null : planProgress(text);
  $.ui.invalidate('ui.render');
}

/** Ask GitHub, at most once per interval, whether a newer Superagent exists. */
async function checkForUpdate($) {
  if (!isEnabled('updateCheck')) return;
  const now = Date.now();
  let cached;
  try {
    cached = await $.store.get(UPDATE_KEY);
  } catch {
    cached = null;
  }
  if (cached && isFresh(cached, state.settings.updateCheck.intervalHours, now)) {
    state.update = cached;
  } else {
    const headers = {
      'User-Agent': 'superagent-update-check',
      Accept: 'application/vnd.github+json',
    };
    let latestVersion = null;
    try {
      const res = await $.http.fetch(LATEST_RELEASE_URL, { headers });
      if (res.ok) {
        const tag = JSON.parse(res.text)?.tag_name;
        if (typeof tag === 'string' && tag) latestVersion = tag.replace(/^v/, '');
      }
    } catch {
      latestVersion = null;
    }
    if (!latestVersion) {
      try {
        const res = await $.http.fetch(PACKAGE_JSON_URL, { headers });
        if (res.ok) latestVersion = JSON.parse(res.text)?.version ?? null;
      } catch {
        latestVersion = null;
      }
    }
    state.update = updateResult({
      cached,
      latestVersion,
      currentVersion: state.version,
      now,
    });
    try {
      await $.store.set(UPDATE_KEY, state.update);
    } catch {
      // A cache that cannot be written only means asking again next time.
    }
  }
  if (state.update?.updateAvailable) {
    $.ui.toast(`Superagent v${state.update.latestVersion} is available — run /update install`);
    $.ui.invalidate('ui.render');
  }
}

/** Repaint once a second while anything runs, so the panel's timers tick. */
function startTicker($) {
  if (state.ticking) return;
  state.ticking = true;
  $.clock.every(1000, () => {
    const busy =
      state.main.running || [...state.children.values()].some((c) => c.state === 'running');
    if (busy && state.ui.open) $.ui.invalidate('ui.render');
  });
}

/** The newest plan path named by any string argument of a tool call. */
const planPathIn = (args) => {
  for (const value of Object.values(args ?? {})) {
    if (typeof value !== 'string') continue;
    const match = ` ${value}`.match(PLAN_PATTERN);
    if (match) return match[1];
  }
  return null;
};

/** The panel's model, in the shape `core/panel.js` draws on either host. */
const panelModel = () => {
  const settings = state.settings;
  const snapshot = board.boardSnapshots()[MAIN];
  const agents = [
    ...(mainRole()
      ? [{ name: `${state.pluginName} (main)`, model: mainRole().model ?? null }]
      : []),
    ...state.roster.registered.map((a) => ({ name: a.name, model: a.model })),
    ...state.council.registered.map((a) => ({ name: a.name, model: a.model })),
  ];
  const progress = state.plan.progress;
  return {
    version: state.version,
    preset: settings?.preset ?? 'unknown',
    subsystems: {
      agents: settings?.agents?.enabled !== false,
      board: settings?.board?.enabled !== false,
      council: settings?.council?.enabled === true,
    },
    agents,
    agentsExpanded: state.ui.agentsExpanded,
    records: snapshot?.records ?? [],
    children: [...state.children.entries()].map(([id, child]) => ({
      id,
      agent: child.agent,
      title: child.title,
      state: child.state,
      current: child.current,
      since: child.since,
    })),
    main: {
      state: state.main.running ? 'running' : 'idle',
      skill: state.main.skill,
      current: state.main.current ?? (state.main.running ? 'thinking' : null),
      since: state.main.since,
    },
    plan:
      state.plan.path && progress ? { name: state.plan.path.split('/').pop(), ...progress } : null,
    now: Date.now(),
    snapshotState: 'ok',
    pluginVersion: state.version,
    updateAvailable: state.update?.updateAvailable === true,
    latestVersion: state.update?.latestVersion ?? null,
    hostNotice: fallbackLine(state.blocked),
    agentRowLimit: state.ui.agentRowLimit,
    dispatchRowLimit: state.ui.dispatchRowLimit,
  };
};

/** The answer for one of our commands that the current preset switched off. */
const offText = (name) =>
  `/${name} is off in the current Superagent preset (${state.settings?.preset ?? 'unknown'}).`;

/** Pass an event on unchanged when a Superagent hook fails. */
const passThrough = ($, e, next) => next(e);

export function register(on) {
  on('session.start', async ($, e, next) => {
    await setup($, e.cwd);
    if (state.sessionRole === undefined) state.sessionRole = state.orchestrator;
    if (e.isInteractive && isEnabled('tui') && isEnabled('board')) {
      const opened = await $.ui.open({ id: PANE, title: 'Superagent' });
      state.ui.open = opened?.isPlaced === true || opened?.isPlaced === false;
    }
    flushLog($);
    return next(e);
  }).catch(passThrough);

  // Registration can be refused before the session binds; try again then.
  on('turn.start', async ($, e, next) => {
    if (!state.registeredOnce && state.settings) await registerAgents($);
    if (!state.updateChecked) {
      state.updateChecked = true;
      checkForUpdate($).catch(() => {});
    }
    if (e.agentId) {
      const child = state.children.get(e.agentId);
      if (child) {
        child.state = 'running';
        child.current = null;
        child.since = Date.now();
      }
      board.reviveChild(e.agentId);
    } else {
      state.main.running = true;
      state.main.current = null;
      state.main.since = Date.now();
    }
    startTicker($);
    $.ui.invalidate('ui.render');
    flushLog($);
    return next(e);
  }).catch(passThrough);

  on('turn.complete', async ($, e, next) => {
    const outcome =
      e.reason === 'answer' ? 'completed' : e.reason === 'aborted' ? 'cancelled' : 'error';
    if (e.agentId) {
      const child = state.children.get(e.agentId);
      if (child) {
        child.state = outcome;
        child.current = null;
      }
      board.settleChild(e.agentId, outcome, e.answer);
    } else {
      state.main.running = false;
      state.main.current = null;
      state.main.since = null;
    }
    $.ui.invalidate('ui.render');
    return next(e);
  }).catch(passThrough);

  // The orchestrator's role, as OpenCode's default agent carries it.
  on('prompt.compose', async ($, e, next) => {
    state.hostHooks.compose = true;
    if (state.blocked?.role) state.blocked = { ...state.blocked, role: false };
    const composed = await next(e);
    const role = state.sessionRole;
    if (!role) return composed;
    return {
      sections: [
        ...composed.sections,
        {
          id: `${state.pluginName}:orchestrator`,
          text: role.prompt,
          scope: 'session',
        },
      ],
    };
  }).catch(passThrough);

  // The orchestrator's routed model and effort, on the main thread's requests.
  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) {
      try {
        await judgeHostHooksOnce($, e);
      } catch {
        // Judging is advisory; the request goes on regardless.
      }
    }
    const routed = mainRole();
    if (e.agentId || !routed || (!routed.model && !routed.effort)) return yield* next(e);
    return yield* next({
      ...e,
      ...(routed.model && routed.model !== 'inherit' ? { model: routed.model } : {}),
      ...(routed.effort ? { effort: routed.effort } : {}),
    });
  });

  // The bootstrap: `using-superagent`, the tool map and the routing table.
  on('prompt.context', async ($, e, next) => {
    state.hostHooks.context = true;
    if (state.blocked?.bootstrap) state.blocked = { ...state.blocked, bootstrap: false };
    const context = await next(e);
    if (!state.bootstrap) return context;
    return {
      ...context,
      blocks: [
        ...context.blocks.filter((b) => b.name !== 'superagent'),
        { name: 'superagent', text: state.bootstrap },
      ],
    };
  }).catch(passThrough);

  // The job board, beside each prompt the main thread receives.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || !isEnabled('board')) return next(e);
    const snapshot = board.renderBoard(MAIN);
    if (!snapshot) return next(e);
    const strategy = state.settings.board.strategy;
    if (strategy !== 'latest' && snapshot === state.lastBoard) return next(e);
    state.lastBoard = snapshot;
    return next({ ...e, context: [...(e.context ?? []), snapshot] });
  }).catch(passThrough);

  // Withhold agent types the current preset does not want.
  on('agent.offer', async ($, e, next) => {
    const ours =
      e.provider?.plugin === state.pluginName ||
      (e.source === 'plugin' && e.agent.startsWith(`${state.pluginName}:`));
    if (ours && state.registeredOnce && !state.active.has(e.agent)) return { isOffered: false };
    return next(e);
  }).catch(passThrough);

  // Record each dispatch and check its file ownership against what is running.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume || e.workflow || e.fork) return next(e);
    const parent = e.parentAgentId ?? MAIN;
    const callID = e.tool_use_id || `spawn-${(state.spawnSeq += 1)}`;
    const args = {
      prompt: e.prompt,
      agent: e.subagentType,
      description: e.description,
      background: e.background,
    };
    board.onDispatch(parent, callID, args, state.settings);
    const result = await next(args.prompt !== e.prompt ? { ...e, prompt: args.prompt } : e);
    if (result?.deny) {
      board.failDispatch(parent, callID, result.deny);
    } else if (result?.agentId) {
      board.linkChild(parent, callID, result.agentId);
      state.agentTypes.set(result.agentId, e.subagentType);
      state.children.set(result.agentId, {
        agent: e.subagentType,
        title: e.description,
        state: 'running',
        current: null,
        since: Date.now(),
      });
    }
    $.ui.invalidate('ui.render');
    return result;
  }).catch(passThrough);

  // What each loop is doing, which skill the main thread follows, and the plan.
  on('tool.call', async ($, e, next) => {
    const label = describeTool(e.tool, e);
    const child = e.agentId ? state.children.get(e.agentId) : null;
    const plan = planPathIn(e);
    if (plan && plan !== state.plan.path) {
      state.plan.path = plan;
      state.plan.progress = null;
    }
    if (!e.agentId && e.tool === 'Skill' && typeof e.skill === 'string') {
      state.main.skill = e.skill.replace(new RegExp(`^${state.pluginName}:`), '');
    }
    if (child) {
      child.current = label;
      child.since = Date.now();
    } else if (!e.agentId) {
      state.main.current = label;
      state.main.since = Date.now();
    }
    $.ui.invalidate('ui.render');

    const result = await next(e);

    if (child && child.current === label) child.current = null;
    if (!e.agentId && state.main.current === label) state.main.current = null;
    if (plan) await refreshPlan($);
    else $.ui.invalidate('ui.render');
    return result;
  }).catch(passThrough);

  // The roster's permission rules: refuse what a role may not do.
  on('tool.check', async ($, e, next) => {
    const agent = e.agentId ? state.agentTypes.get(e.agentId) : null;
    const rules = e.agentId
      ? agent
        ? state.rules[agent]
        : null
      : mainRole()
        ? mainRole().rules
        : null;
    const verdict = rules
      ? checkCall(rules, e.tool, e.input, {
          cwd: state.cwd,
          agent: agent ?? `${state.pluginName} orchestrator`,
        })
      : null;
    if (verdict?.decision === 'deny') return verdict;
    const decided = await next(e);
    if (verdict?.decision === 'ask' && decided?.decision === 'allow') return verdict;
    return decided;
  }).catch(passThrough);

  // ------------------------------------------------------------- commands

  on('command.describe', async ($, e, next) => {
    const described = await next(e);
    if (!state.commands.has(e.command) || state.offeredCommands?.has(e.command)) return described;
    return { ...described, isHidden: true };
  }).catch(passThrough);

  on('command.run', { command: 'board' }, async ($, e, next) => {
    if (!state.commands.has('board')) return next(e);
    if (!state.offeredCommands?.has('board')) return { text: offText('board') };
    return { text: boardText(board.renderBoard(MAIN)) };
  }).catch(passThrough);

  on('command.run', { command: 'preset' }, async ($, e, next) => {
    if (!state.commands.has('preset')) return next(e);
    if (!state.offeredCommands?.has('preset')) return { text: offText('preset') };
    const answer = presetCommand(state.settings, e.args);
    if (!answer.persist) {
      const notice = fallbackLine(state.blocked);
      const shows = !String(e.args ?? '').trim() || String(e.args).trim() === 'show';
      return { text: notice && shows ? `${answer.text}\n${notice}` : answer.text };
    }

    const name = answer.persist;
    let saved = false;
    try {
      await $.fs.write(state.files.state, `${JSON.stringify({ preset: name }, null, 2)}\n`);
      saved = true;
    } catch (err) {
      logQueue.push({ level: 'warn', text: `could not persist preset: ${err}` });
    }
    let applied = false;
    if (saved) {
      try {
        await setup($, state.cwd);
        $.ui.invalidate('prompt.context');
        $.ui.invalidate('command.describe');
        $.ui.invalidate('ui.render');
        applied = true;
      } catch (err) {
        logQueue.push({ level: 'warn', text: `could not apply preset: ${err}` });
      }
    }
    flushLog($);
    return { text: presetSavedText(name, { saved, applied, stateFile: state.files.state }) };
  }).catch(passThrough);

  on('command.run', { command: 'update' }, async ($, e, next) => {
    if (!state.commands.has('update')) return next(e);
    if (!state.offeredCommands?.has('update')) return { text: offText('update') };
    const [action] = String(e.args ?? '')
      .trim()
      .split(/\s+/);
    if (action !== 'install') {
      let cache = state.update;
      if (!cache) {
        try {
          cache = (await $.store.get(UPDATE_KEY)) ?? null;
        } catch {
          cache = null;
        }
      }
      return { text: updateText(cache) };
    }
    const plan = updatePlan({
      isGitCheckout: await $.fs.exists(pluginFile(state.root, '.git')),
      root: state.root,
      pluginId: state.pluginName,
    });
    let outcome;
    try {
      const run = await $.process.run(plan.argv, { cwd: state.root, timeoutMs: 120000 });
      outcome = { ok: run.exitCode === 0, output: run.stderr || run.stdout };
    } catch (err) {
      outcome = { ok: false, output: String(err) };
    }
    return { text: installText(plan, outcome) };
  }).catch(passThrough);

  on('command.run', { command: 'council' }, async ($, e, next) => {
    if (!state.commands.has('council')) return next(e);
    if (!state.offeredCommands?.has('council')) return { text: offText('council') };
    const councillors = state.council.registered.filter((c) => state.active.has(c.name));
    if (!state.settings.council.enabled || councillors.length < 2) {
      return { text: councilUnavailableText(state.settings) };
    }
    const text = councilInstruction(councillors, String(e.args ?? '').trim(), { host: 'claude' });
    // The council needs the model. A command's hook holds the turn it would
    // start, so the instruction is submitted just after the command returns.
    $.clock.after(0, () => {
      $.prompt.submit({ text }).catch((err) => {
        logQueue.push({ level: 'warn', text: `could not convene the council: ${err}` });
      });
    });
    return { text: `Convening the council: ${councillors.map((c) => c.name).join(', ')}.` };
  }).catch(passThrough);

  on('command.run', { command: PANEL_COMMAND }, async ($, e, next) => {
    if (!state.commands.has(PANEL_COMMAND)) return next(e);
    if (!state.offeredCommands?.has(PANEL_COMMAND)) return { text: offText(PANEL_COMMAND) };
    if (state.ui.open) {
      await $.ui.close(PANE);
      state.ui.open = false;
      return { text: 'Superagent panel hidden. Run /superagent to show it again.' };
    }
    const opened = await $.ui.open({ id: PANE, title: 'Superagent' });
    state.ui.open = true;
    return {
      text: opened?.isPlaced
        ? 'Superagent panel shown.'
        : `Superagent panel is waiting for room: ${opened?.reason ?? 'the window is too narrow'}.`,
    };
  }).catch(passThrough);

  // ---------------------------------------------------------------- panel

  on('ui.close', { id: PANE }, async ($, e, next) => {
    state.ui.open = false;
    return next(e);
  }).catch(passThrough);

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e);
    const width = Math.max(20, (e.props?.bodyColumns ?? 40) - 2);
    return drawPanel(
      {
        ...panelModel(),
        onToggleAgents: () => {
          state.ui.agentsExpanded = !state.ui.agentsExpanded;
          state.ui.agentRowLimit = 8;
          $.ui.invalidate('ui.render');
        },
        onRevealMoreAgents: () => {
          state.ui.agentRowLimit += 8;
          $.ui.invalidate('ui.render');
        },
        onRevealMoreDispatches: () => {
          state.ui.dispatchRowLimit += 5;
          $.ui.invalidate('ui.render');
        },
      },
      elements,
      width,
    );
  });
}
