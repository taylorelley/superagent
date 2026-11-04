/**
 * Versions and the update check's pure parts, shared by both hosts. Fetching
 * and caching are each host's job: OpenCode's server uses `fetch` and a cache
 * file, Claude Code's hooks module uses `$.http.fetch` and `$.store`.
 */

export const REPO_OWNER = 'taylorelley';
export const REPO_NAME = 'superagent';

/** Where the latest version is published: a release first, then `package.json`. */
export const LATEST_RELEASE_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
export const PACKAGE_JSON_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/HEAD/package.json`;

/**
 * Compare two `x.y.z`-style version strings.
 *
 * Missing parts are treated as 0, so "1.2" equals "1.2.0". A non-numeric part
 * compares as 0 — good enough for this project's CalVer `YYYY.M.MICRO`
 * versions (which also sort above the old `0.x` line), and it never throws on a
 * malformed string from a broken fetch.
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

/**
 * The result of one check, given what the fetch found (`latestVersion`, null
 * when it failed) and the previous result.
 *
 * A failed fetch still refreshes `checkedAt` — so a broken connection is
 * retried once per interval rather than once per session — but keeps whatever
 * `latestVersion`/`updateAvailable` the last successful check found.
 */
export const updateResult = ({ cached, latestVersion, currentVersion, now }) => ({
  checkedAt: now,
  currentVersion: currentVersion ?? null,
  latestVersion: latestVersion ?? cached?.latestVersion ?? null,
  updateAvailable: latestVersion
    ? compareVersions(latestVersion, currentVersion) > 0
    : (cached?.updateAvailable ?? false),
});

/** Whether a cached result is still inside the check interval. */
export const isFresh = (cached, intervalHours, now) => {
  const intervalMs = Math.max(0, intervalHours ?? 24) * 60 * 60 * 1000;
  return Boolean(cached?.checkedAt) && now - cached.checkedAt < intervalMs;
};
