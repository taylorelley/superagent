/**
 * Logging and error containment.
 *
 * OpenCode runs plugin `config` hooks under `Effect.ignore`, which swallows
 * throws. A malformed user config would otherwise produce no agents and no
 * error — the plugin would look like it simply did nothing. So nothing in this
 * plugin is allowed to throw out of a hook: every hook body is wrapped in
 * `guard`, which logs loudly and returns a fallback instead.
 */

const PREFIX = '[superagent/opencode]';

const debugEnabled = (env = process.env) =>
  env.SUPERAGENT_DEBUG === '1' || env.SUPERAGENT_DEBUG === 'true';

export const debug = (...args) => {
  if (debugEnabled()) console.error(PREFIX, '[debug]', ...args);
};

export const warn = (...args) => {
  console.error(PREFIX, '[warn]', ...args);
};

export const error = (...args) => {
  console.error(PREFIX, '[error]', ...args);
};

/**
 * Run `fn`, returning `fallback` if it throws or rejects.
 *
 * `label` names the failing operation in the log so a swallowed hook is still
 * traceable to a line of code.
 */
export const guard = async (label, fn, fallback = undefined) => {
  try {
    return await fn();
  } catch (err) {
    error(`${label} failed:`, err && err.stack ? err.stack : err);
    return fallback;
  }
};

/** Wrap an OpenCode hook so a throw can never escape into the host. */
export const guardHook = (label, fn) => async (...args) => {
  await guard(label, () => fn(...args));
};
