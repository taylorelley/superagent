import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const statePath = (configDir, scope) =>
  path.join(
    configDir,
    'superagent',
    `${createHash('sha256').update(String(scope)).digest('hex').slice(0, 24)}.json`,
  );
const empty = () => ({ version: 1, boards: {}, sessions: {}, activity: {} });
export async function readState(file) {
  try {
    const state = JSON.parse(await fs.readFile(file, 'utf8'));
    if (state.version !== 1 || !state.boards || !state.sessions || !state.activity)
      throw new Error('Invalid Superagent state');
    return state;
  } catch (error) {
    if (error.code === 'ENOENT') return empty();
    throw error;
  }
}
export async function withState(file, update, { timeoutMs = 5000 } = {}) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fs.mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (Date.now() >= deadline)
        throw new Error('Superagent state lock busy; no update was written', { cause: error });
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const state = await readState(file);
    const result = await update(state);
    await fs.writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: 'wx' });
    await fs.rename(temporary, file);
    return result;
  } finally {
    await fs.rm(temporary, { force: true });
    await fs.rmdir(lock);
  }
}

const linkPath = (configDir, sessionID) =>
  path.join(
    configDir,
    'superagent',
    'sessions',
    `${createHash('sha256').update(sessionID).digest('hex')}.json`,
  );
/** Route child hooks back to their controller's transaction and live panel. */
export async function sessionScope(configDir, sessionID) {
  try {
    const value = JSON.parse(await fs.readFile(linkPath(configDir, sessionID), 'utf8'));
    if (typeof value.root !== 'string' || !value.root) throw new Error('Invalid session link');
    return value.root;
  } catch (error) {
    if (error.code === 'ENOENT') return sessionID;
    throw error;
  }
}
export async function linkSession(configDir, child, root) {
  const file = linkPath(configDir, child);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify({ root }) + '\n', { flag: 'wx', mode: 0o600 });
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
