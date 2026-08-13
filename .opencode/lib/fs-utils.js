/**
 * Filesystem and parsing helpers shared across the OpenCode plugin.
 *
 * Everything here is a pure function over its arguments so it can be unit
 * tested without an OpenCode binary.
 */

import path from 'path';

/**
 * Split YAML frontmatter off a markdown document.
 *
 * Deliberately minimal: the bootstrap path must not depend on skills-core or
 * any YAML library, and the only frontmatter Superpowers skills carry is flat
 * `key: value` pairs.
 */
export const extractAndStripFrontmatter = (content) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content };

  const frontmatterStr = match[1];
  const body = match[2];
  const frontmatter = {};

  for (const line of frontmatterStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, '');
      frontmatter[key] = value;
    }
  }

  return { frontmatter, content: body };
};

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
