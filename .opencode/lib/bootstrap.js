/**
 * Session bootstrap: the `using-superpowers` skill, injected into every session.
 *
 * Injected as a *user* message rather than a system message, deliberately:
 * system messages are repeated every turn (token bloat, #750) and multiple
 * system messages break Qwen and other models (#894).
 *
 * The transform that consumes this fires on every agent *step*, not every
 * turn — OpenCode's prompt loop reloads messages from the database each step —
 * so the content is cached at module level. Without the cache this would do an
 * `existsSync` + `readFileSync` + regex parse per step (#1202), which
 * `tests/opencode/test-bootstrap-caching.mjs` guards against by counting
 * filesystem calls.
 */

import path from 'path';
import fs from 'fs';
import { extractAndStripFrontmatter } from './fs-utils.js';
import { skillsDir as defaultSkillsDir } from './paths.js';
import { renderBootstrapToolMap } from './tool-map.js';

/** The marker used to detect an already-injected bootstrap. */
export const BOOTSTRAP_MARKER = 'EXTREMELY_IMPORTANT';

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
 * `extra` is appended inside the block. It is read on the first call only, so
 * anything passed here must be stable for the life of the session.
 */
export const getBootstrapContent = (skillsDir = defaultSkillsDir, extra = '') => {
  if (cache !== undefined && cacheKey === skillsDir) return cache;

  const skillPath = path.join(skillsDir, 'using-superpowers', 'SKILL.md');
  cacheKey = skillsDir;

  if (!fs.existsSync(skillPath)) {
    cache = null;
    return null;
  }

  const { content } = extractAndStripFrontmatter(fs.readFileSync(skillPath, 'utf8'));

  cache = [
    '<EXTREMELY_IMPORTANT>',
    'You have superpowers.',
    '',
    '**IMPORTANT: The using-superpowers skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the skill tool to load "using-superpowers" again - that would be redundant.**',
    '',
    content,
    '',
    renderBootstrapToolMap(),
    ...(extra ? ['', extra] : []),
    '</EXTREMELY_IMPORTANT>',
  ].join('\n');

  return cache;
};

/**
 * Prepend the bootstrap to the first user message, once.
 *
 * The guard is a content check rather than a flag because OpenCode may pass an
 * already-transformed in-memory message array back through the hook.
 */
export const injectBootstrap = (messages, bootstrap) => {
  if (!bootstrap || !messages || !messages.length) return false;

  const firstUser = messages.find((m) => m.info.role === 'user');
  if (!firstUser || !firstUser.parts.length) return false;

  const alreadyInjected = firstUser.parts.some(
    (p) => p.type === 'text' && p.text.includes(BOOTSTRAP_MARKER)
  );
  if (alreadyInjected) return false;

  const ref = firstUser.parts[0];
  firstUser.parts.unshift({ ...ref, type: 'text', text: bootstrap });
  return true;
};
