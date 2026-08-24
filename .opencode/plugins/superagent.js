/**
 * Superagent plugin for OpenCode.ai
 *
 * Responsibilities at this layer:
 *   1. Register the shared `skills/` directory so OpenCode's native `skill`
 *      tool discovers Superagent skills without symlinks or config edits.
 *   2. Register the Superagent specialist roster (see `../lib/roster.js`).
 *   3. Inject the `using-superagent` bootstrap, plus the routing table that
 *      tells the orchestrator which specialists this session actually has.
 *
 * This file stays thin on purpose: it wires hooks and contains no logic.
 * Everything it calls lives in `../lib/`, as pure functions that can be unit
 * tested without an OpenCode binary. Hooks are wrapped so a throw can never
 * escape into the host — OpenCode runs `config` under `Effect.ignore`, which
 * would swallow the error and leave the plugin silently inert.
 */

import { skillsDir, resolveConfigDir } from '../lib/paths.js';
import { getBootstrapContent, injectBootstrap } from '../lib/bootstrap.js';
import { loadConfig } from '../lib/config-schema.js';
import { registerAgents } from '../lib/agents.js';
import { renderRoutingTable, renderConflicts } from '../lib/routing.js';
import { backgroundSubagentsAvailable } from '../lib/capabilities.js';
import {
  onDispatch,
  onDispatchResult,
  onSessionEvent,
  injectBoard,
  boardSnapshots,
} from '../lib/board.js';
import { snapshotPath, writeSnapshot, readVersion } from '../lib/tui-snapshot.js';
import { checkForUpdate, cachePath, readCache } from '../lib/update-check.js';
import { registerCouncillors } from '../lib/council.js';
import { registerCommands, expandCommand } from '../lib/commands.js';
import { guardHook, debug } from '../lib/log.js';

export const SuperagentPlugin = async ({ client, directory }) => {
  const configDir = resolveConfigDir();
  const settings = loadConfig({ configDir, projectDir: directory });

  // Rendered during the config hook, once the roster is known, and then held
  // for the life of the session. The transform hook fires on every agent step,
  // so it must not do work.
  let routingTable = '';
  let councillors = [];

  // The sidebar panel runs in the TUI process and cannot see the board's
  // in-memory ledger, so each change is projected to a file it polls. Resolved
  // once: neither the config directory nor the project directory moves.
  const snapshotFile =
    settings.tui?.enabled === false || settings.board?.enabled === false
      ? null
      : snapshotPath(configDir, directory);

  const publishBoard = () => {
    if (!snapshotFile) return;
    const updateCache = readCache(cachePath(configDir));
    writeSnapshot(snapshotFile, {
      directory,
      pluginVersion: readVersion(),
      updateAvailable: updateCache?.updateAvailable ?? false,
      latestVersion: updateCache?.latestVersion ?? null,
      sessions: boardSnapshots(),
    });
  };

  // Guards the update check to at most once per OpenCode process, not once
  // per session — `session.created` fires for every child session a dispatch
  // opens too.
  let updateChecked = false;

  return {
    config: guardHook('config hook', async (config) => {
      if (!config) return;

      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }

      const conflicts = [];
      const registered = registerAgents(config, settings, { conflicts });
      councillors = registerCouncillors(config, settings, { conflicts });
      registerCommands(config, settings, { conflicts });
      if (registered.length) {
        routingTable = renderRoutingTable(registered, {
          backgroundAvailable: backgroundSubagentsAvailable(),
        });
      }
      if (conflicts.length) {
        routingTable = [routingTable, renderConflicts(conflicts)].filter(Boolean).join('\n\n');
      }
      debug(`preset=${settings.preset} agents=${registered.length} conflicts=${conflicts.length}`);
    }),

    // Commands expand here rather than in their template, because the
    // expansion depends on state the template cannot see: the councillors that
    // were actually registered, the live board, the resolved preset.
    'command.execute.before': guardHook('command.execute.before', async (input, output) => {
      // Guard before expanding, not after: `/preset <name> --persist` writes the
      // state file as a side effect, so expanding without somewhere to put the
      // reply would persist the change and tell the user nothing.
      if (!output) return;
      const text = expandCommand(input?.command, input?.arguments, {
        settings,
        councillors,
        configDir,
        sessionID: input?.sessionID,
      });
      if (!text) return;
      output.parts = [{ type: 'text', text }];
    }),

    // Record each dispatch and check its file ownership against what is
    // already running. Runs before the tool, so the outgoing prompt can be
    // annotated when two dispatches claim the same paths.
    'tool.execute.before': guardHook('tool.execute.before', async (input, output) => {
      if (input?.tool !== 'task') return;
      onDispatch(input.sessionID, input.callID, output?.args, settings);
      publishBoard();
    }),

    'tool.execute.after': guardHook('tool.execute.after', async (input, output) => {
      if (input?.tool !== 'task') return;
      onDispatchResult(input.sessionID, input.callID, output, settings);
      publishBoard();
    }),

    // Background dispatches return as soon as the job starts, so their outcome
    // arrives as a session lifecycle event on the child.
    event: guardHook('event', async ({ event } = {}) => {
      if (!event?.type) return;
      const changed = onSessionEvent(
        event.type,
        event.properties?.sessionID ?? event.properties?.info?.id,
      );
      if (changed) publishBoard();

      if (
        event.type === 'session.created' &&
        !updateChecked &&
        settings.updateCheck?.enabled !== false
      ) {
        updateChecked = true;
        const result = await checkForUpdate({
          currentVersion: readVersion(),
          cacheFile: cachePath(configDir),
          intervalHours: settings.updateCheck?.intervalHours,
        });
        if (result?.updateAvailable) {
          publishBoard();
          // Best-effort: `client.tui.showToast` is not yet independently
          // verified against this project's pinned OpenCode source (see
          // docs/superagent.md, "Still unverified"). The sidebar panel line
          // `publishBoard()` just wrote is the confirmed-working fallback, so
          // a missing or throwing toast API must not be treated as an error.
          try {
            await client?.tui?.showToast?.({
              body: {
                message: `Superagent update available: v${result.latestVersion} (run /update install)`,
                variant: 'info',
              },
            });
          } catch (err) {
            debug(`update toast failed: ${err.message}`);
          }
        }
      }
    }),

    'experimental.chat.messages.transform': guardHook(
      'messages transform',
      async (_input, output) => {
        if (settings.bootstrap?.enabled !== false) {
          injectBootstrap(output?.messages, getBootstrapContent(skillsDir, routingTable));
        }
        injectBoard(output?.messages, settings);
      },
    ),
  };
};
