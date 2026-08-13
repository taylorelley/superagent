/**
 * Superpowers plugin for OpenCode.ai
 *
 * Responsibilities at this layer:
 *   1. Register the shared `skills/` directory so OpenCode's native `skill`
 *      tool discovers Superpowers skills without symlinks or config edits.
 *   2. Register the Superagent specialist roster (see `../lib/roster.js`).
 *   3. Inject the `using-superpowers` bootstrap, plus the routing table that
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
import { renderRoutingTable } from '../lib/routing.js';
import { backgroundSubagentsAvailable } from '../lib/capabilities.js';
import { guardHook, debug } from '../lib/log.js';

export const SuperpowersPlugin = async ({ client, directory }) => {
  const settings = loadConfig({
    configDir: resolveConfigDir(),
    projectDir: directory,
  });

  // Rendered during the config hook, once the roster is known, and then held
  // for the life of the session. The transform hook fires on every agent step,
  // so it must not do work.
  let routingTable = '';

  return {
    config: guardHook('config hook', async (config) => {
      if (!config) return;

      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }

      const registered = registerAgents(config, settings);
      if (registered.length) {
        routingTable = renderRoutingTable(registered, {
          backgroundAvailable: backgroundSubagentsAvailable(),
        });
      }
      debug(`preset=${settings.preset} agents=${registered.length}`);
    }),

    'experimental.chat.messages.transform': guardHook(
      'messages transform',
      async (_input, output) => {
        if (settings.bootstrap?.enabled === false) return;
        injectBootstrap(output?.messages, getBootstrapContent(skillsDir, routingTable));
      }
    ),
  };
};
