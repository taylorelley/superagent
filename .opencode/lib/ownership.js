/**
 * File ownership between concurrent dispatches.
 *
 * Two write-capable specialists editing the same file concurrently is the
 * failure mode that makes parallel dispatch worse than serial: both succeed,
 * one silently loses. The orchestrator declares what each dispatch may write,
 * and this module checks the claims against each other.
 *
 * The declaration rides in the task prompt as a comment, so it costs the
 * orchestrator one line and needs no tool-schema change:
 *
 *     <!-- superagent-ownership: write=src/api/**,src/db/**; read=src/** -->
 */

const MARKER = /<!--\s*superagent-ownership:\s*([^>]*?)\s*-->/i;

/**
 * Pull the ownership declaration out of a dispatch prompt.
 *
 * Returns `null` when there is no marker at all, which is different from an
 * empty claim — the caller warns about the former.
 */
export const parseOwnership = (prompt) => {
  if (typeof prompt !== 'string') return null;
  const match = prompt.match(MARKER);
  if (!match) return null;

  const claim = { write: [], read: [] };
  for (const clause of match[1].split(';')) {
    const [rawKey, rawValue] = clause.split('=');
    if (!rawValue) continue;
    const key = rawKey.trim().toLowerCase();
    if (key !== 'write' && key !== 'read') continue;
    claim[key] = rawValue
      .split(',')
      .map((glob) => glob.trim())
      .filter(Boolean);
  }
  return claim;
};

/** Translate a glob to a regex. `**` crosses separators, `*` does not. */
const globToRegExp = (glob) => {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1; // `**/` also matches zero directories
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
};

// Patterns repeat across every pairwise comparison in a dispatch, and the
// alternations are cheap to match but not free to compile.
const regexCache = new Map();
const cachedRegExp = (glob) => {
  let compiled = regexCache.get(glob);
  if (!compiled) {
    compiled = globToRegExp(glob);
    regexCache.set(glob, compiled);
  }
  return compiled;
};

/**
 * Do two write claims overlap?
 *
 * Exact glob intersection is undecidable in general, so this is deliberately a
 * conservative approximation: two patterns conflict if either matches the
 * other's literal prefix. It over-reports rather than under-reports, because a
 * spurious warning costs a sentence and a missed conflict costs work.
 */
export const globsOverlap = (a, b) => {
  if (a === b) return true;
  const literalPrefix = (glob) => glob.split(/[*?]/)[0];
  return (
    cachedRegExp(a).test(literalPrefix(b)) ||
    cachedRegExp(b).test(literalPrefix(a)) ||
    literalPrefix(a).startsWith(literalPrefix(b)) ||
    literalPrefix(b).startsWith(literalPrefix(a))
  );
};

/** Which of `others` claim write access overlapping `claim`. */
export const findConflicts = (claim, others) => {
  if (!claim?.write?.length) return [];
  return others.filter((other) =>
    other.ownership?.write?.some((theirs) => claim.write.some((ours) => globsOverlap(ours, theirs)))
  );
};

/** The note prepended to a conflicting dispatch's prompt. */
export const conflictNotice = (conflicts) =>
  [
    '<SUPERAGENT_OWNERSHIP_CONFLICT>',
    'Another dispatch is already running and claims write access to paths that',
    'overlap yours:',
    ...conflicts.map(
      (other) => `  - ${other.agent} (${other.objective}) owns: ${other.ownership.write.join(', ')}`
    ),
    '',
    'Do not edit files inside those paths. If your task cannot be completed',
    'without them, stop and reply with the conflict instead of writing.',
    '</SUPERAGENT_OWNERSHIP_CONFLICT>',
    '',
  ].join('\n');
