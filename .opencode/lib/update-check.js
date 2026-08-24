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
import { snapshotDir } from './tui-snapshot.js';

export const REPO_OWNER = 'taylorelley';
export const REPO_NAME = 'superagent';

/** Where the last check result is cached, alongside the TUI snapshots. */
export const cachePath = (configDir) =>
  configDir ? path.join(snapshotDir(configDir), 'update-check.json') : null;

/**
 * Compare two `x.y.z`-style version strings.
 *
 * Missing parts are treated as 0, so "1.2" equals "1.2.0". A non-numeric part
 * compares as 0 — good enough for this project's plain semver, and it never
 * throws on a malformed string from a broken fetch.
 */
export const compareVersions = (a, b) => {
  const parts = (v) =>
    String(v ?? '')
      .split('.')
      .map((p) => parseInt(p, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
};

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
  const intervalMs = Math.max(0, intervalHours) * 60 * 60 * 1000;
  if (cached?.checkedAt && now - cached.checkedAt < intervalMs) return cached;

  const latestVersion = await fetchLatestVersion({ owner, repo, fetchImpl });
  const result = {
    checkedAt: now,
    currentVersion: currentVersion ?? null,
    latestVersion: latestVersion ?? cached?.latestVersion ?? null,
    updateAvailable: latestVersion
      ? compareVersions(latestVersion, currentVersion) > 0
      : (cached?.updateAvailable ?? false),
  };
  writeCache(cacheFile, result);
  return result;
};
