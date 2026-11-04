/**
 * Filesystem and parsing helpers shared across the OpenCode plugin.
 *
 * The host-neutral parsers live in `core/parse.js` and are re-exported here;
 * only path handling, which needs Node's `path`, stays in this module.
 */

import path from 'path';

export { extractAndStripFrontmatter, stripJsonc, deepMerge } from '../../core/parse.js';

/** Trim whitespace, expand a leading `~`, and resolve to an absolute path. */
export const normalizePath = (p, homeDir) => {
  if (!p || typeof p !== 'string') return null;
  let normalized = p.trim();
  if (!normalized) return null;
  if (normalized.startsWith('~/')) {
    normalized = path.join(homeDir, normalized.slice(2));
  } else if (normalized === '~') {
    normalized = homeDir;
  }
  return path.resolve(normalized);
};
