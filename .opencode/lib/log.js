/**
 * Logging and error containment.
 *
 * A throw out of a V2 hook fails the operation it intercepts — a model
 * request, a tool call — and a throw out of a transform is logged by OpenCode
 * and leaves that registration out, which looks exactly like the plugin
 * simply doing nothing. So nothing in this plugin is allowed to throw out of a
 * hook or a transform: every body is wrapped in `guard` / `guardSync`, which
 * log loudly and return a fallback instead.
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

/**
 * Synchronous `guard`, for transform callbacks — OpenCode requires those to
 * be synchronous, so they cannot be wrapped in a promise.
 */
export const guardSync = (label, fn, fallback = undefined) => {
  try {
    return fn();
  } catch (err) {
    error(`${label} failed:`, err && err.stack ? err.stack : err);
    return fallback;
  }
};

/** Wrap an OpenCode hook so a throw can never escape into the host. */
export const guardHook =
  (label, fn) =>
  async (...args) => {
    await guard(label, () => fn(...args));
  };
