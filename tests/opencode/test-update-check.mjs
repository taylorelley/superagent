/**
 * Unit tests for the update-check module.
 *
 * The GitHub fetch is always injected — these tests never touch the network.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  cachePath,
  compareVersions,
  checkForUpdate,
  fetchLatestVersion,
  readCache,
  writeCache,
} from '../../.opencode/lib/update-check.js';

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'superagent-update-'));

const jsonResponse = (body, ok = true) => ({
  ok,
  json: async () => body,
});

// -------------------------------------------------------------- compareVersions

test('compareVersions treats missing parts as zero', () => {
  assert.equal(compareVersions('1.2', '1.2.0'), 0);
  assert.equal(compareVersions('1.2.1', '1.2'), 1);
  assert.equal(compareVersions('1.2', '1.2.1'), -1);
});

test('compareVersions compares numerically, not lexically', () => {
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
});

test('compareVersions treats a non-numeric part as zero rather than throwing', () => {
  assert.equal(compareVersions('1.x.0', '1.0.0'), 0);
});

// ------------------------------------------------------------------- cache I/O

test('cachePath is null without a config directory', () => {
  assert.equal(cachePath(null), null);
});

test('writeCache then readCache round-trips', () => {
  const dir = tempDir();
  const file = path.join(dir, 'update-check.json');
  writeCache(file, { checkedAt: 123, latestVersion: '1.0.0' });
  assert.deepEqual(readCache(file), { checkedAt: 123, latestVersion: '1.0.0' });
});

test('readCache is null for a missing file, never throws', () => {
  assert.equal(readCache(path.join(tempDir(), 'missing.json')), null);
});

test('readCache is null for corrupt JSON, never throws', () => {
  const dir = tempDir();
  const file = path.join(dir, 'update-check.json');
  fs.writeFileSync(file, 'not json');
  assert.equal(readCache(file), null);
});

// ------------------------------------------------------------ fetchLatestVersion

test('fetchLatestVersion prefers the release tag when the releases endpoint succeeds', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('/releases/latest')) return jsonResponse({ tag_name: 'v1.2.3' });
    throw new Error('should not fall back');
  };
  const version = await fetchLatestVersion({ owner: 'o', repo: 'r', fetchImpl });
  assert.equal(version, '1.2.3');
  assert.equal(calls.length, 1);
});

test('fetchLatestVersion falls back to package.json on the default branch when there is no release', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('/releases/latest')) return jsonResponse({}, false);
    if (url.includes('raw.githubusercontent.com')) return jsonResponse({ version: '2.0.0' });
    throw new Error('unexpected url: ' + url);
  };
  const version = await fetchLatestVersion({ owner: 'o', repo: 'r', fetchImpl });
  assert.equal(version, '2.0.0');
});

test('fetchLatestVersion returns null when both requests fail, never throws', async () => {
  const fetchImpl = async () => {
    throw new Error('network down');
  };
  const version = await fetchLatestVersion({ owner: 'o', repo: 'r', fetchImpl });
  assert.equal(version, null);
});

// -------------------------------------------------------------- checkForUpdate

test('checkForUpdate reuses a cache still inside the interval, without fetching', async () => {
  const dir = tempDir();
  const cacheFile = path.join(dir, 'update-check.json');
  const now = 1_000_000;
  writeCache(cacheFile, {
    checkedAt: now - 1000,
    currentVersion: '1.0.0',
    latestVersion: '1.0.0',
    updateAvailable: false,
  });

  let fetchCalled = false;
  const result = await checkForUpdate({
    currentVersion: '1.0.0',
    cacheFile,
    intervalHours: 24,
    now,
    fetchImpl: async () => {
      fetchCalled = true;
      throw new Error('must not be called');
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(result.updateAvailable, false);
});

test('checkForUpdate fetches and reports an available update past the interval', async () => {
  const dir = tempDir();
  const cacheFile = path.join(dir, 'update-check.json');
  const fetchImpl = async (url) =>
    url.includes('/releases/latest')
      ? jsonResponse({ tag_name: '9.9.9' })
      : jsonResponse({}, false);

  const result = await checkForUpdate({
    currentVersion: '1.0.0',
    cacheFile,
    intervalHours: 24,
    now: 1_000_000,
    fetchImpl,
  });

  assert.equal(result.latestVersion, '9.9.9');
  assert.equal(result.updateAvailable, true);
  assert.deepEqual(readCache(cacheFile), result);
});

test('checkForUpdate keeps the last known result when a due fetch fails, but refreshes checkedAt', async () => {
  const dir = tempDir();
  const cacheFile = path.join(dir, 'update-check.json');
  writeCache(cacheFile, {
    checkedAt: 0,
    currentVersion: '1.0.0',
    latestVersion: '2.0.0',
    updateAvailable: true,
  });

  const result = await checkForUpdate({
    currentVersion: '1.0.0',
    cacheFile,
    intervalHours: 24,
    now: 1_000_000,
    fetchImpl: async () => {
      throw new Error('network down');
    },
  });

  assert.equal(result.checkedAt, 1_000_000);
  assert.equal(result.latestVersion, '2.0.0');
  assert.equal(result.updateAvailable, true);
});
