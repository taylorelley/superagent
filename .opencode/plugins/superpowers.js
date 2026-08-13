/**
 * Superpowers plugin for OpenCode.ai
 *
 * Two responsibilities at this layer:
 *   1. Register the shared `skills/` directory so OpenCode's native `skill`
 *      tool discovers Superpowers skills without symlinks or config edits.
 *   2. Inject the `using-superpowers` bootstrap into each session.
 *
 * This file stays thin on purpose: it wires hooks and contains no logic.
 * Everything it calls lives in `../lib/`, as pure functions that can be unit
 * tested without an OpenCode binary. Hooks are wrapped so a throw can never
 * escape into the host — OpenCode runs `config` under `Effect.ignore`, which
 * would swallow the error and leave the plugin silently inert.
 */

import { skillsDir } from '../lib/paths.js';
import { getBootstrapContent, injectBootstrap } from '../lib/bootstrap.js';
import { guardHook } from '../lib/log.js';

export const SuperpowersPlugin = async ({ client, directory }) => {
  return {
    /**
     * Register the skills directory on the live config.
     *
     * This works because `Config.get()` returns a cached singleton, so a
     * mutation here is visible when skills are lazily discovered later.
     */
    config: guardHook('config hook', async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      if (!config.skills.paths.includes(skillsDir)) {
        config.skills.paths.push(skillsDir);
      }
    }),

    'experimental.chat.messages.transform': guardHook(
      'messages transform',
      async (_input, output) => {
        injectBootstrap(output.messages, getBootstrapContent(skillsDir));
      }
    ),
  };
};
