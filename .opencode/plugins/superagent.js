/**
 * Superagent plugin for OpenCode V2 (the server part).
 *
 * Responsibilities at this layer:
 *   1. Register the shared `skills/` through the skill transform, so OpenCode's
 *      native `skill` tool discovers Superagent skills without symlinks.
 *   2. Register the Superagent specialist roster (see `../lib/roster.js`) and
 *      council through the agent transform, and its slash commands.
 *   3. Inject the `using-superagent` bootstrap, the routing table that tells
 *      the orchestrator which specialists this session actually has, and the
 *      job board, through the session `context` hook.
 *
 * This file stays thin on purpose: it wires hooks and contains no logic; what
 * it calls lives in `../lib/` as pure, unit-tested functions. A V2 plugin is a
 * plain `{ id, setup }` object — `Plugin.define` from `@opencode/plugin` is the
 * identity function — so the plugin stays zero-dependency. Every hook and
 * transform body is guarded so a throw can never escape into the host.
 */

import { skillsDir, resolveConfigDir } from '../lib/paths.js';
import { getBootstrapContent, injectBootstrap } from '../lib/bootstrap.js';
import { loadConfig } from '../lib/config-schema.js';
import { registerAgents, preloadPrompts, warnConflicts } from '../lib/agents.js';
import { discoverSkills, registerSkills, watchSkills } from '../lib/skills.js';
import { renderRoutingTable, renderConflicts } from '../lib/routing.js';
import { defaultAgentConfigured } from '../lib/opencode-config.js';
import * as board from '../lib/board.js';
import { readVersion } from '../lib/tui-snapshot.js';
import { checkForUpdate, cachePath, publishSnapshot } from '../lib/update-check.js';
import { registerCouncillors, usableMembers } from '../lib/council.js';
import { commandsToRegister, expandCommand } from '../lib/commands.js';
import { guard, guardSync, guardHook, debug } from '../lib/log.js';

const setup = async (ctx) => {
  const directory = ctx.location?.directory ?? process.cwd();
  const configDir = resolveConfigDir();
  const load = () => loadConfig({ configDir, projectDir: directory });
  let settings = load();
  let members = usableMembers(settings.council);

  // Everything a transform needs is read here, once: transforms are replayed
  // whenever a registry rebuilds and must stay synchronous and I/O free.
  let skills = discoverSkills(skillsDir);
  preloadPrompts();
  const userChoseDefault = defaultAgentConfigured({ configDir, projectDir: directory });

  // Written by the agent transform on each replay; read by the hooks.
  const state = { routingTable: '', councillors: [], temperatures: {} };

  // The command editor can only add, and a later add would shadow the user's
  // own command of the same name, so collisions are found up front.
  const existing = await guard(
    'command list',
    async () => new Set(((await ctx.command.list())?.data ?? []).map((c) => c.name)),
    new Set(),
  );

  // The sidebar panel runs in the TUI and cannot see the board's in-memory
  // ledger, so each change is projected to a file it watches.
  const publishBoard = () =>
    publishSnapshot({
      settings,
      configDir,
      directory,
      version: readVersion(),
      sessions: board.boardSnapshots(),
    });

  await ctx.skill.transform((editor) =>
    guardSync('skill transform', () => registerSkills(editor, skills)),
  );
  const unwatchSkills = watchSkills(skillsDir, () => {
    skills = discoverSkills(skillsDir);
    void ctx.skill.reload();
  });

  await ctx.agent.transform((editor) =>
    guardSync('agent transform', () => {
      const agents = registerAgents(editor, settings, { defaultAgentConfigured: userChoseDefault });
      const council = registerCouncillors(editor, settings, members);
      const commandConflicts = commandsToRegister(settings, existing).conflicts;
      const conflicts = [...agents.conflicts, ...council.conflicts, ...commandConflicts];
      warnConflicts(conflicts);
      state.councillors = council.registered;
      state.temperatures = agents.temperatures;
      state.routingTable = [
        agents.registered.length ? renderRoutingTable(agents.registered) : '',
        renderConflicts(conflicts),
      ]
        .filter(Boolean)
        .join('\n\n');
      debug(`preset=${settings.preset} agents=${agents.registered.length}`);
    }),
  );

  const applyPreset = () => {
    settings = load();
    members = usableMembers(settings.council);
    void ctx.agent.reload();
    void ctx.command.reload();
  };

  // Commands expand at execution, because the expansion depends on state a
  // definition cannot see: the registered councillors, the live board, the
  // resolved preset. The expansion is submitted as the session's next prompt.
  await ctx.command.transform((editor) =>
    guardSync('command transform', () => {
      for (const { name, description } of commandsToRegister(settings, existing).commands) {
        editor.add({
          name,
          description,
          execute: guardHook(`/${name}`, async ({ sessionID, prompt, delivery }) => {
            const text = expandCommand(name, prompt?.text ?? '', {
              settings,
              councillors: state.councillors,
              configDir,
              sessionID,
              onPresetPersist: applyPreset,
            });
            if (!text) return;
            await ctx.session.prompt({ ...prompt, sessionID, text, delivery });
          }),
        });
      }
    }),
  );

  // Runs before every agent-loop model request. Changes reach only the
  // outgoing request, never persisted history.
  await ctx.session.hook(
    'context',
    guardHook('context hook', (event) => {
      const temperature = state.temperatures[event.agent];
      if (typeof temperature === 'number' && event.options?.temperature === undefined) {
        event.options.temperature = temperature;
      }
      if (settings.bootstrap?.enabled !== false) {
        injectBootstrap(event.messages, getBootstrapContent(skillsDir, state.routingTable));
      }
      board.injectBoard(event.messages, event.sessionID, settings);
    }),
  );

  // Record each dispatch and check its file ownership against what is already
  // running. Runs before the tool, so the outgoing prompt can be annotated.
  await ctx.tool.hook(
    'execute.before',
    guardHook('subagent execute.before', (event) => {
      if (event.tool !== 'subagent') return;
      const input = { ...(event.input ?? {}) };
      board.onDispatch(event.sessionID, event.id, input, settings);
      if (input.prompt !== event.input?.prompt) event.input = input;
      publishBoard();
    }),
  );

  await ctx.tool.hook(
    'execute.after',
    guardHook('subagent execute.after', (event) => {
      if (event.tool !== 'subagent') return;
      board.onDispatchResult(event.sessionID, event.id, event, settings);
      publishBoard();
    }),
  );

  // Once per instance, on the first session, so a slow network never delays
  // startup. The panel reads the result from the snapshot.
  let updateChecked = settings.updateCheck?.enabled === false;
  const checkUpdate = () =>
    guard('update check', async () => {
      const result = await checkForUpdate({
        currentVersion: readVersion(),
        cacheFile: cachePath(configDir),
        intervalHours: settings.updateCheck?.intervalHours,
      });
      if (result?.updateAvailable) publishBoard();
    });

  // Background dispatches return as soon as the child starts, so their outcome
  // arrives as a lifecycle event on the child session.
  const controller = new AbortController();
  void guard('event subscription', async () => {
    const types = ['session.created', ...Object.keys(board.TERMINAL_EVENTS)];
    for await (const event of ctx.event.subscribe({ types, signal: controller.signal })) {
      if (event.type === 'session.created') {
        if (!updateChecked) void checkUpdate();
        updateChecked = true;
      } else if (board.onSessionEvent(event.type, event.data?.sessionID)) {
        publishBoard();
      }
    }
  });

  return () => {
    controller.abort();
    unwatchSkills();
  };
};

export default { id: 'superagent', setup };
