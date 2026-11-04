/**
 * Update checking: compares the installed version against GitHub, throttled
 * and cached to a file so a session never blocks on the network and a flaky
 * connection is not retried on every single startup.
 *
 * Nothing here throws — a broken cache file or a failed fetch degrades to "no
 * update known" rather than taking down the hook that calls it.
 */

import fs from 'fs';
import path from 'path';
import { warn, debug } from './log.js';
import { snapshotDir, snapshotPath, writeSnapshot } from './tui-snapshot.js';
import { REPO_OWNER, REPO_NAME, updateResult, isFresh } from '../../core/versions.js';

export { REPO_OWNER, REPO_NAME, compareVersions } from '../../core/versions.js';

/** Where the last check result is cached, alongside the TUI snapshots. */
export const cachePath = (configDir) =>
  configDir ? path.join(snapshotDir(configDir), 'update-check.json') : null;

/** Read the cache, or null when there is none to read. */
export const readCache = (filePath) => {
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (err) {
    if (err.code !== 'ENOENT') debug(`could not read the update-check cache: ${err.message}`);
    return null;
  }
};

/** Write the cache, temp-file-then-rename so a reader never sees a half-written file. */
export const writeCache = (filePath, payload) => {
  if (!filePath) return false;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`);
    fs.renameSync(tmp, filePath);
    return true;
  } catch (err) {
    warn(`could not write the update-check cache: ${err.message}`);
    return false;
  }
};

/**
 * Fetch the latest published version from GitHub.
 *
 * Tries a GitHub Release first (works once this repo has one), then falls
 * back to `package.json` on the default branch (works today, before any
 * release has been cut). Returns null on any failure — network, non-2xx, or a
 * response that doesn't parse — never throws.
 */
export const fetchLatestVersion = async ({
  owner = REPO_OWNER,
  repo = REPO_NAME,
  fetchImpl = fetch,
  timeoutMs = 5000,
} = {}) => {
  const headers = { 'User-Agent': `${repo}-update-check`, Accept: 'application/vnd.github+json' };

  try {
    const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/releases/latest`, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) {
      const body = await res.json();
      const tag = typeof body?.tag_name === 'string' ? body.tag_name.replace(/^v/, '') : null;
      if (tag) return tag;
    }
  } catch (err) {
    debug(`update check: releases/latest failed: ${err.message}`);
  }

  try {
    const res = await fetchImpl(
      `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/package.json`,
      { headers, signal: AbortSignal.timeout(timeoutMs) },
    );
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.version === 'string' ? body.version : null;
  } catch (err) {
    debug(`update check: package.json fallback failed: ${err.message}`);
    return null;
  }
};

/**
 * The orchestrator: throttle, fetch when due, compare, cache, return.
 *
 * A cache still within `intervalHours` is returned unchanged, with no network
 * call at all. A failed fetch still refreshes `checkedAt` — so a broken
 * connection is retried once per interval rather than once per session — but
 * keeps whatever `latestVersion`/`updateAvailable` the last successful check
 * found.
 */
export const checkForUpdate = async ({
  currentVersion,
  cacheFile,
  intervalHours = 24,
  owner = REPO_OWNER,
  repo = REPO_NAME,
  now = Date.now(),
  fetchImpl = fetch,
} = {}) => {
  const cached = readCache(cacheFile);
  if (isFresh(cached, intervalHours, now)) return cached;

  const latestVersion = await fetchLatestVersion({ owner, repo, fetchImpl });
  const result = updateResult({ cached, latestVersion, currentVersion, now });
  writeCache(cacheFile, result);
  return result;
};

/**
 * Project the board to the TUI snapshot file, with the cached update status.
 *
 * Lives here rather than in `tui-snapshot.js` only because that module is
 * imported by this one; it is the one place the board, the snapshot and the
 * update cache meet. Writes nothing when the panel or the board is off.
 */
export const publishSnapshot = ({ settings, configDir, directory, version, sessions }) => {
  // Decided per call: a live `/preset --persist` can turn the board on or off.
  if (settings?.tui?.enabled === false || settings?.board?.enabled === false) return false;
  const file = snapshotPath(configDir, directory);
  const updateCache = readCache(cachePath(configDir));
  return writeSnapshot(file, {
    directory,
    pluginVersion: version,
    updateAvailable: updateCache?.updateAvailable ?? false,
    latestVersion: updateCache?.latestVersion ?? null,
    sessions,
  });
};
