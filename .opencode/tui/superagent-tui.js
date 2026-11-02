/**
 * Superagent's TUI plugin for OpenCode V2: the sidebar panel.
 *
 * This is the package's `./tui` export. In V2 one `plugins` entry in
 * `opencode.json` loads every part of a package — the TUI loads the TUI parts
 * of the plugins its server loads — so there is no separate `tui.json` entry
 * any more. A TUI part is a plain `{ id, setup(context) }` object, like the
 * server part.
 *
 * Thin on purpose, like `../plugins/superagent.js`: this file resolves the
 * host's OpenTUI and Solid runtimes, assembles the model, and watches the
 * board snapshot. The layout lives in `../lib/tui-panel.js` as a pure
 * function, and everything it needs about the roster and the configuration
 * comes from the same modules the server plugin uses, so the two can never
 * tell the user different stories.
 *
 * ## Getting an element factory without a dependency
 *
 * OpenTUI and Solid are not dependencies of this package, by policy and by
 * practicality — the TUI must render through the host's own instances, not
 * second copies. The host maps its runtime modules onto virtual
 * `opentui:runtime-module:*` ids, which resolve from anywhere, including a
 * plugin installed under `node_modules`; a bare `@opentui/solid` import only
 * works for plugins that ship OpenTUI themselves. Both are tried, in that
 * order, and a failure to load either one is not fatal — the panel simply
 * does not register.
 *
 * ## Staying live
 *
 * V2 renders a slot claim inside Solid's ownership tree, and OpenTUI finds its
 * renderer through Solid context. So the panel's root is filled with a
 * *reactive* `insert`: the poll timer and the click handlers bump a signal,
 * and Solid re-runs the insert inside the slot's own owner, where creating
 * elements is legal. That replaces V1's workaround of repainting only when the
 * host happened to re-invoke the slot.
 */

import fs from 'fs';
import { resolveConfigDir } from '../lib/paths.js';
import { loadConfig, stateFilePath, CONFIG_BASENAME } from '../lib/config-schema.js';
import path from 'path';
import { ROSTER } from '../lib/roster.js';
import { renderPanel, panelTheme, MAX_AGENT_ROWS, MAX_DISPATCH_ROWS } from '../lib/tui-panel.js';
import { snapshotPath, readSnapshot, sessionRecords, readVersion } from '../lib/tui-snapshot.js';
import { debug, warn } from '../lib/log.js';

export { readVersion };

/** How often the board snapshot is re-checked. */
const POLL_MS = 1000;

const runtimeSpecifiers = (name) => [`opentui:runtime-module:${encodeURIComponent(name)}`, name];

/** Wrap OpenTUI's Solid renderer in the `{ box, text }` the panel wants. */
export const elementFactory = (mod) => {
  const { createElement, setProp, insert } = mod ?? {};
  const element = (tag, props, children = []) => {
    const node = createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value !== undefined) setProp(node, key, value);
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      insert(node, child);
    }
    return node;
  };
  return {
    box: (props, children) => element('box', props, children),
    text: (props, children) => element('text', props, children),
  };
};

/** Import the first specifier that yields a module passing `accept`. */
const importFirst = async (specifiers, accept) => {
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      if (accept(mod)) {
        debug(`tui panel using ${specifier}`);
        return mod;
      }
    } catch (err) {
      debug(`tui panel could not import ${specifier}: ${err.message}`);
    }
  }
  return null;
};

/**
 * The host runtimes the panel renders through: OpenTUI's Solid renderer (for
 * elements and reactive `insert`) and Solid itself (for the signal).
 */
export const loadRuntime = async ({
  solidSpecifiers = runtimeSpecifiers('@opentui/solid'),
  signalSpecifiers = runtimeSpecifiers('solid-js'),
} = {}) => {
  const solid = await importFirst(
    solidSpecifiers,
    (mod) => typeof mod?.createElement === 'function' && typeof mod?.insert === 'function',
  );
  const signals = await importFirst(
    signalSpecifiers,
    (mod) => typeof mod?.createSignal === 'function',
  );
  if (!solid || !signals) return null;
  return { h: elementFactory(solid), insert: solid.insert, createSignal: signals.createSignal };
};

/**
 * The roster as the panel should list it.
 *
 * Derived rather than reported: `registerAgents` skips a roster entry when it
 * is disabled by config or when its name is already taken, and the agent list
 * the TUI already holds for this location is enough to see the difference —
 * with one honest limitation: an entry whose name collided is listed under the
 * *other* agent's definition, so presence means "an agent by this name
 * exists", not "ours won". `agents` is that list (`[{ id }]`), or null while
 * it has not loaded, in which case nothing is filtered out.
 */
export const panelAgents = (settings, agents) => {
  if (settings?.agents?.enabled === false) return [];

  const { prefix = '', disable = [], models = {} } = settings?.agents ?? {};
  const known = Array.isArray(agents) ? new Set(agents.map((agent) => agent?.id)) : null;

  return ROSTER.filter((entry) => !disable.includes(entry.key))
    .map((entry) => ({ name: `${prefix}${entry.key}`, model: models[entry.slot] ?? null }))
    .filter((agent) => !known || known.has(agent.name));
};

/**
 * The most recently touched session in a snapshot — the fallback when the
 * slot was rendered without a session.
 */
export const newestSessionID = (snapshot) => {
  const entries = Object.entries(snapshot?.sessions ?? {});
  if (!entries.length) return null;
  return entries.sort(([, a], [, b]) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0][0];
};

/**
 * Why the Dispatches section is (or is not) showing records.
 *
 * `readSnapshot` returns null both when there is no file and when the file is
 * from an incompatible format, so `hasFile` (mtime > 0) disambiguates them.
 * A payload whose server plugin version differs from this panel's copy is the
 * version-skew case the docs warn about — visible here, not silent.
 */
export const dispatchState = ({ hasFile, snapshot, panelVersion }) => {
  if (!hasFile) return 'none';
  if (!snapshot) return 'incompatible';
  if (snapshot.pluginVersion && panelVersion && snapshot.pluginVersion !== panelVersion) {
    return 'version-mismatch';
  }
  if (!snapshot.pluginVersion) {
    debug('tui panel: snapshot has no pluginVersion; skipping the version-skew check');
  }
  return 'ok';
};

/**
 * Runtime UI state for the panel's click affordances.
 *
 * A tiny state machine, not part of `renderPanel` (which stays a pure
 * function of its inputs): the Agents section's expanded/collapsed flag and
 * both lists' row limits live here, seeded once from config and mutated only
 * by a click. `onChange` is called after every mutation — in practice it
 * bumps the signal the panel's reactive insert reads.
 */
export const createPanelInteractions = (agentsExpandedDefault, onChange) => {
  let agentsExpanded = agentsExpandedDefault === true;
  let agentRowLimit = MAX_AGENT_ROWS;
  let dispatchRowLimit = MAX_DISPATCH_ROWS;

  return {
    get state() {
      return { agentsExpanded, agentRowLimit, dispatchRowLimit };
    },
    // Toggling always resets the page: re-expanding after collapsing should
    // not resume mid-page from a previous session of clicking "+N more".
    toggleAgents: () => {
      agentsExpanded = !agentsExpanded;
      agentRowLimit = MAX_AGENT_ROWS;
      onChange?.();
    },
    revealMoreAgents: () => {
      agentRowLimit += MAX_AGENT_ROWS;
      onChange?.();
    },
    revealMoreDispatches: () => {
      dispatchRowLimit += MAX_DISPATCH_ROWS;
      onChange?.();
    },
  };
};

const mtimeOf = (target) => {
  try {
    return fs.statSync(target).mtimeMs;
  } catch {
    return 0;
  }
};

/**
 * `deps` is not part of OpenCode's call signature — it is an injection seam
 * so tests can hand `setup` a recording runtime instead of the host's.
 */
const setup = async (context, deps = {}) => {
  const location = context?.location ?? context?.data?.location?.default?.();
  const directory = location?.directory ?? process.cwd();
  const configDir = resolveConfigDir();
  let settings = loadConfig({ configDir, projectDir: directory });
  if (settings.tui?.enabled === false) {
    debug('tui panel disabled by config');
    return undefined;
  }

  const runtime = await (deps.loadRuntime ?? loadRuntime)();
  if (!runtime) {
    warn('could not load the OpenTUI runtime; the Superagent sidebar panel is not available');
    return undefined;
  }
  const { h, insert, createSignal } = runtime;

  const version = readVersion() ?? context?.app?.version ?? 'dev';
  const subsystemsOf = (current) => ({
    agents: current.agents?.enabled !== false,
    board: current.board?.enabled !== false,
    council: current.council?.enabled === true,
  });

  // The files settings come from. A live `/preset --persist` on the server
  // rewrites the state file, so the panel re-resolves when any of them moves.
  const settingsFiles = [
    path.join(configDir, `${CONFIG_BASENAME}.json`),
    path.join(configDir, `${CONFIG_BASENAME}.jsonc`),
    stateFilePath(configDir),
    path.join(directory, '.opencode', `${CONFIG_BASENAME}.json`),
    path.join(directory, '.opencode', `${CONFIG_BASENAME}.jsonc`),
  ];

  const file = snapshotPath(configDir, directory);
  let stamp = mtimeOf(file);
  let snapshot = stamp > 0 ? readSnapshot(file) : null;

  const [tick, setTick] = createSignal(0);
  const bump = () => setTick((n) => n + 1);
  const interactions = createPanelInteractions(settings.tui?.agents?.expanded, bump);

  // The roster section lists what this location actually registered. The
  // agent list is the host's reactive data, so reading it inside the panel's
  // insert keeps the section current after a sync.
  const agentData = context?.data?.location?.agent;
  void Promise.resolve(agentData?.sync?.(location)).catch((err) =>
    debug(`tui panel: agent sync failed: ${err.message}`),
  );

  // One toast per TUI process when the server reports an update.
  let toasted = false;
  const announceUpdate = () => {
    if (toasted || !snapshot?.updateAvailable) return;
    toasted = true;
    context?.ui?.toast?.show?.({
      title: 'Superagent',
      message: `Update available: v${snapshot.latestVersion} (run /update install)`,
      variant: 'info',
    });
  };
  announceUpdate();

  const build = (sessionID) => {
    const current = sessionID || newestSessionID(snapshot);
    return renderPanel(
      {
        version,
        preset: settings.preset,
        subsystems: subsystemsOf(settings),
        agents: panelAgents(settings, agentData?.list?.(location) ?? null),
        records: sessionRecords(snapshot, current),
        snapshotState: dispatchState({ hasFile: stamp > 0, snapshot, panelVersion: version }),
        pluginVersion: snapshot?.pluginVersion ?? null,
        updateAvailable: snapshot?.updateAvailable ?? false,
        latestVersion: snapshot?.latestVersion ?? null,
        theme: panelTheme(context?.theme),
        ...interactions.state,
        onToggleAgents: interactions.toggleAgents,
        onRevealMoreAgents: interactions.revealMoreAgents,
        onRevealMoreDispatches: interactions.revealMoreDispatches,
      },
      h,
    );
  };

  // Only re-parse when the file actually moved: this runs for the life of the
  // TUI, next to a renderer whose whole job is not doing unnecessary work.
  const settingsStamp = () => settingsFiles.map(mtimeOf).join(':');
  let configStamp = settingsStamp();
  const poll = () => {
    const mtime = mtimeOf(file);
    const nextConfig = settingsStamp();
    if (mtime === stamp && nextConfig === configStamp) return;
    if (nextConfig !== configStamp) {
      configStamp = nextConfig;
      settings = loadConfig({ configDir, projectDir: directory });
    }
    if (mtime !== stamp) {
      stamp = mtime;
      snapshot = mtime > 0 ? readSnapshot(file) : null;
      announceUpdate();
    }
    bump();
  };
  const timer = setInterval(poll, POLL_MS);
  timer.unref?.();

  const release = context.ui.slot({
    append: 'sidebar.content',
    render: (input) => {
      const root = h.box({ width: '100%', flexDirection: 'column' }, []);
      insert(root, () => {
        tick();
        try {
          return build(input?.sessionID);
        } catch (err) {
          debug(`tui panel: render failed: ${err.message}`);
          return null;
        }
      });
      return root;
    },
  });

  debug(`tui panel registered (v${version}, preset ${settings.preset})`);
  return () => {
    clearInterval(timer);
    release?.();
  };
};

export default { id: 'superagent.tui', setup };
