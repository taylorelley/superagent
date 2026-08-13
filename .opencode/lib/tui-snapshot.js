/**
 * The bridge between the plugin and the TUI panel.
 *
 * ## Why a file
 *
 * OpenCode loads a package's server entry and its TUI entry as two separate
 * modules — `readV1Plugin` rejects a module that exports both — and runs them
 * in two different processes. So the job board that `board.js` keeps in memory
 * is not reachable from the panel, however the two are started. A small file,
 * written when the board changes and polled by the panel, is the whole bridge.
 *
 * Only the board crosses. Everything else the panel shows (version, preset,
 * roster, model routing) is recomputed on the TUI side from the same modules
 * the plugin uses, so there is nothing to keep in sync and nothing to go stale.
 *
 * ## Why one file per project
 *
 * The snapshot lives under OpenCode's config directory, which is shared by
 * every project. Two OpenCode instances writing one file would clobber each
 * other, so the path is keyed by the project directory. Both sides can derive
 * it: the plugin gets `directory` in its input, and the panel reads the same
 * value from `api.state.path.directory`.
 *
 * Nothing here throws. A panel is a nicety; it must never be able to take down
 * the session that feeds it.
 */

import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import { warn, debug } from './log.js';

export const SNAPSHOT_VERSION = 1;

/** Sessions retained per project. Older ones are dropped on write. */
export const MAX_SESSIONS = 20;

/** Directory holding every project's snapshot, under OpenCode's config dir. */
export const snapshotDir = (configDir) => path.join(configDir, 'superagent');

/**
 * Where this project's snapshot lives.
 *
 * The project directory is hashed rather than sanitized: a readable name would
 * have to escape separators, and two different paths could still collide after
 * escaping. Twelve hex characters is far more than enough to keep one user's
 * checkouts apart, and the file says which directory it belongs to anyway.
 */
export const snapshotPath = (configDir, projectDir) => {
  if (!configDir) return null;
  const key = createHash('sha256').update(path.resolve(projectDir || '.')).digest('hex').slice(0, 12);
  return path.join(snapshotDir(configDir), `tui-${key}.json`);
};

/** Keep the most recently updated sessions, dropping the rest. */
export const pruneSessions = (sessions, max = MAX_SESSIONS) => {
  const entries = Object.entries(sessions ?? {});
  if (entries.length <= max) return { ...sessions };
  return Object.fromEntries(
    entries
      .sort(([, a], [, b]) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))
      .slice(0, max)
  );
};

/** Serialized form of the last write, so an unchanged board costs no I/O. */
const lastWritten = new Map();

export const resetSnapshotCache = () => lastWritten.clear();

/**
 * Write the snapshot, unless it would be byte-identical to the last one.
 *
 * The dispatch hooks fire often and most of them change nothing the panel
 * shows, so the comparison is what keeps this off the hot path. The write goes
 * to a temp file and is renamed, because the panel polls this file and a reader
 * must never catch a half-written one.
 *
 * Returns true when a write happened.
 */
export const writeSnapshot = (filePath, payload) => {
  if (!filePath) return false;

  try {
    const body = `${JSON.stringify(
      { version: SNAPSHOT_VERSION, ...payload, sessions: pruneSessions(payload?.sessions) },
      null,
      2
    )}\n`;
    if (lastWritten.get(filePath) === body) return false;

    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, filePath);
    lastWritten.set(filePath, body);
    debug(`wrote tui snapshot: ${filePath}`);
    return true;
  } catch (err) {
    warn(`could not write the TUI snapshot: ${err.message}`);
    return false;
  }
};

/**
 * Read a snapshot, or null when there is none to read.
 *
 * A missing file is the normal state before the first dispatch, so it is not
 * worth a warning. Anything else — unreadable, truncated, from a future version
 * — degrades to null and the panel simply shows no dispatches.
 */
export const readSnapshot = (filePath) => {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    if (parsed.version !== SNAPSHOT_VERSION) return null;
    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') debug(`could not read the TUI snapshot: ${err.message}`);
    return null;
  }
};

/** The records for one session, or an empty list. */
export const sessionRecords = (snapshot, sessionID) => {
  const records = snapshot?.sessions?.[sessionID]?.records;
  return Array.isArray(records) ? records : [];
};
