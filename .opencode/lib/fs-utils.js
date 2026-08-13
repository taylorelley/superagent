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
 * any YAML library, and the only frontmatter Superagent skills carry is flat
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

/**
 * Strip `//` and block comments and trailing commas from JSON.
 *
 * OpenCode's own config files accept comments, so Superagent's should too. A
 * dependency-free stripper has to be string-aware or it mangles any value
 * containing `//` — a URL, most obviously. This walks the text tracking whether
 * it is inside a string, which is enough for JSONC.
 */
export const stripJsonc = (text) => {
  let out = '';
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        out += ch;
      }
      continue;
    }

    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }

    if (inString) {
      out += ch;
      // A backslash escapes the next character, including a closing quote.
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }

    out += ch;
  }

  // Trailing commas, now that comments can no longer hide one.
  return out.replace(/,(\s*[}\]])/g, '$1');
};

/** Plain-object test — arrays and null are not merge targets. */
const isPlainObject = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * Recursively merge `source` onto `target`, returning a new object.
 *
 * Objects merge; arrays and scalars replace. Replacing arrays is deliberate —
 * a user who lists council members expects their list, not their list appended
 * to the shipped one.
 */
export const deepMerge = (target, source) => {
  if (!isPlainObject(source)) return source === undefined ? target : source;
  if (!isPlainObject(target)) return deepMerge({}, source);

  const out = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) ? deepMerge(target[key], value) : value;
  }
  return out;
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
