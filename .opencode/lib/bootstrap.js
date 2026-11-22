/**
 * Session bootstrap: the `using-superagent` skill, injected into every session.
 *
 * The text itself is built by `core/bootstrap.js`, shared with the Claude Code
 * plugin; this module reads the skill file for OpenCode and caches the result.
 *
 * The `context` hook that consumes this fires before every model request of
 * the agent loop — every *step*, not every turn, tool-driven continuations
 * included — so the content is cached at module level. Without the cache this would do an
 * `existsSync` + `readFileSync` + regex parse per step (#1202), which
 * `tests/opencode/test-bootstrap-caching.mjs` guards against by counting
 * filesystem calls.
 */

import path from 'path';
import fs from 'fs';
import { skillsDir as defaultSkillsDir } from './paths.js';
import { injectBootstrap, renderBootstrap } from '../../core/bootstrap.js';

import { supercriticalContext, supercriticalPlan } from '../../core/supercritical.js';

export { BOOTSTRAP_MARKER, withContent, injectBootstrap } from '../../core/bootstrap.js';

// undefined = not yet loaded, null = SKILL.md missing. Both are cached: a
// missing file must not be re-probed on every step either.
let cache = undefined;
let cacheKey = undefined;

/** Test seam — drops the memoized bootstrap. */
export const resetBootstrapCache = () => {
  cache = undefined;
  cacheKey = undefined;
};

/**
 * Build the bootstrap text, or return null when the skill is unavailable.
 *
 * `extra` is appended inside the block — the routing table, in practice. It is
 * part of the cache key rather than read-once, so that a caller which renders
 * it later than the first call gets the rebuilt text instead of silently
 * keeping a version without it. The routing table only changes when the agent
 * registry is rebuilt, so this costs one extra read per rebuild at most.
 */
export const getBootstrapContent = (skillsDir = defaultSkillsDir, extra = '') => {
  const key = `${skillsDir}\u0000${extra}`;
  if (cache !== undefined && cacheKey === key) return cache;

  const skillPath = path.join(skillsDir, 'using-superagent', 'SKILL.md');
  cacheKey = key;

  if (!fs.existsSync(skillPath)) {
    cache = null;
    return null;
  }

  cache = renderBootstrap(fs.readFileSync(skillPath, 'utf8'), { host: 'opencode', extra });
  return cache;
};

export const injectProjectBootstrap = (messages, directory, routing, settings) => {
  if (settings.bootstrap?.enabled !== false) {
    injectBootstrap(messages, getBootstrapContent(defaultSkillsDir, routing));
  }
  if (fs.existsSync(path.join(directory, supercriticalPlan))) {
    injectBootstrap(messages, supercriticalContext, '<supercritical>');
  }
};
