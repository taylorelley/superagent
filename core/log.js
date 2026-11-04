/**
 * Host-neutral logging.
 *
 * `core/` runs in two hosts. OpenCode's server is Node, with `process` and a
 * `console` writing to stderr. A Claude Code hooks module runs in an
 * environment of its own: it has a `console` but no `process`, and its real
 * log is `$.ui.log`, which only the hooks module itself may call. So nothing
 * here touches a host global at import time, and each host can replace the
 * sink and the debug switch with `configureLog`.
 */

const state = {
  prefix: '[superagent]',
  sink: null,
  debugEnabled: null,
};

const envDebug = () => {
  const env = globalThis.process?.env;
  return env?.SUPERAGENT_DEBUG === '1' || env?.SUPERAGENT_DEBUG === 'true';
};

const defaultSink = (level, args) => {
  globalThis.console?.error?.(state.prefix, `[${level}]`, ...args);
};

/**
 * Point logging somewhere else.
 *
 * `prefix` names the host in the default sink's lines; `sink(level, args)`
 * replaces the sink outright; `debug` is a boolean or a function answering
 * whether debug lines are wanted. Omitted keys keep their current value.
 */
export const configureLog = ({ prefix, sink, debug: debugSetting } = {}) => {
  if (typeof prefix === 'string') state.prefix = prefix;
  if (sink !== undefined) state.sink = typeof sink === 'function' ? sink : null;
  if (debugSetting !== undefined) state.debugEnabled = debugSetting;
};

const isDebug = () => {
  const setting = state.debugEnabled;
  if (typeof setting === 'function') return Boolean(setting());
  if (typeof setting === 'boolean') return setting;
  return envDebug();
};

const emit = (level, args) => {
  try {
    (state.sink ?? defaultSink)(level, args);
  } catch {
    // A logger that throws would take its caller down with it.
  }
};

export const debug = (...args) => {
  if (isDebug()) emit('debug', args);
};

export const warn = (...args) => emit('warn', args);

export const error = (...args) => emit('error', args);
