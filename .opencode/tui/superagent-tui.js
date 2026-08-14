/**
 * Superagent's TUI plugin: the sidebar panel.
 *
 * Registered separately from the server plugin, because OpenCode requires it:
 * a plugin module default-exports either `server()` or `tui()`, never both, and
 * the TUI entry is resolved from `exports["./tui"]` in package.json. It is also
 * configured separately — the TUI reads its plugin list from `tui.json`, not
 * `opencode.json`. See docs/superagent.md for the details and the sources.
 *
 * Thin on purpose, like `../plugins/superagent.js`: this file resolves the
 * element factory, assembles the model, and polls. The layout lives in
 * `../lib/tui-panel.js` as a pure function, and everything it needs about the
 * roster and the configuration comes from the same modules the server plugin
 * uses, so the two can never tell the user different stories.
 *
 * ## Getting an element factory without a dependency
 *
 * OpenTUI is not a dependency of this package, by policy and by practicality —
 * the TUI must render through the host's own instance, not a second copy. The
 * host installs a Bun module resolver that maps its runtime modules onto
 * virtual `opentui:runtime-module:*` ids (`@opentui/solid`'s
 * `ensureRuntimePluginSupport`), and those ids resolve from anywhere, including
 * a plugin installed under `node_modules`. A bare `@opentui/solid` import does
 * not: the resolver deliberately leaves bare specifiers inside `node_modules`
 * alone, so it only works for plugins that ship OpenTUI themselves. Both are
 * tried, in that order, and a failure to load either one is not fatal — the
 * panel simply does not register.
 */

import fs from 'fs';
import { resolveConfigDir } from '../lib/paths.js';
import { loadConfig } from '../lib/config-schema.js';
import { ROSTER } from '../lib/roster.js';
import { renderPanel } from '../lib/tui-panel.js';
import { snapshotPath, readSnapshot, sessionRecords } from '../lib/tui-snapshot.js';
import { debug, warn } from '../lib/log.js';

export { readVersion } from '../lib/tui-snapshot.js';

/** How often the board snapshot is re-checked. Slim uses the same cadence. */
const POLL_MS = 1000;

const SOLID_SPECIFIERS = [
  `opentui:runtime-module:${encodeURIComponent('@opentui/solid')}`,
  '@opentui/solid',
];

/** Wrap OpenTUI's imperative element API in the `{ box, text }` the panel wants. */
export const elementFactory = ({ createElement, setProp, insert }) => {
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

export const loadElementFactory = async (specifiers = SOLID_SPECIFIERS) => {
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      if (typeof mod?.createElement === 'function') {
        debug(`tui panel using ${specifier}`);
        return elementFactory(mod);
      }
    } catch (err) {
      debug(`tui panel could not import ${specifier}: ${err.message}`);
    }
  }
  return null;
};

/**
 * The roster as the panel should list it.
 *
 * Derived rather than reported: the plugin knows exactly which agents it
 * registered, but telling the panel would mean a second thing to keep in the
 * snapshot and a second thing to go stale. `registerAgents` skips a roster
 * entry when it is disabled by config or when its name is already taken, and
 * the resolved agent map the TUI already holds is enough to see the difference
 * — with one honest limitation: an entry whose name collided is indexed under
 * the *other* agent's definition, so presence means "a agent by this name
 * exists", not "ours won".
 */
export const panelAgents = (settings, config) => {
  if (settings?.agents?.enabled === false) return [];

  const { prefix = '', disable = [], models = {} } = settings?.agents ?? {};
  const registered = config?.agent && typeof config.agent === 'object' ? config.agent : null;

  return ROSTER.filter((entry) => !disable.includes(entry.key))
    .map((entry) => ({ name: `${prefix}${entry.key}`, model: models[entry.slot] ?? null }))
    .filter((agent) => !registered || Object.prototype.hasOwnProperty.call(registered, agent.name));
};

/**
 * The most recently touched session in a snapshot.
 *
 * A fallback for picking which board to show. `sidebar_content` declares a
 * `session_id` prop, but what a slot function actually receives is the slot
 * *context* — `{ theme }` — so the id has to come from the route instead, and
 * this covers the case where that is not a session route either. Wrong only if
 * two sessions in one project are dispatching at once, and then only until the
 * next dispatch.
 */
export const newestSessionID = (snapshot) => {
  const entries = Object.entries(snapshot?.sessions ?? {});
  if (!entries.length) return null;
  return entries.sort(([, a], [, b]) => (b?.updatedAt ?? 0) - (a?.updatedAt ?? 0))[0][0];
};

/** The session the panel should be describing. */
export const currentSessionID = (api, props, snapshot) => {
  const route = api?.route?.current;
  if (route?.name === 'session' && route.params?.sessionID) return route.params.sessionID;
  return props?.session_id ?? newestSessionID(snapshot);
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
  return 'ok';
};

export default {
  id: 'superagent:tui',

  tui: async (api, _options, meta) => {
    const configDir = resolveConfigDir();
    const directory = api?.state?.path?.directory ?? process.cwd();
    const settings = loadConfig({ configDir, projectDir: directory });
    if (settings.tui?.enabled === false) {
      debug('tui panel disabled by config');
      return;
    }

    const h = await loadElementFactory();
    if (!h) {
      warn(
        'could not load the OpenTUI element factory; the Superagent sidebar panel is not available'
      );
      return;
    }

    const version = readVersion() ?? meta?.version ?? 'dev';
    const subsystems = {
      agents: settings.agents?.enabled !== false,
      board: settings.board?.enabled !== false,
      council: settings.council?.enabled === true,
    };

    const mtimeOf = (target) => {
      try {
        return fs.statSync(target).mtimeMs;
      } catch {
        return 0;
      }
    };

    let file = snapshotPath(configDir, directory);
    let stamp = mtimeOf(file);
    let hasFile = stamp > 0;
    let snapshot = hasFile ? readSnapshot(file) : null;

    // Only re-parse when the file actually moved, and only ask for a repaint
    // when something changed: this runs for the life of the session, next to a
    // renderer whose whole job is not doing unnecessary work.
    const poll = () => {
      const current = api?.state?.path?.directory ?? directory;
      const next = snapshotPath(configDir, current);
      const mtime = mtimeOf(next);
      if (next === file && mtime === stamp) return;
      file = next;
      stamp = mtime;
      hasFile = mtime > 0;
      snapshot = hasFile ? readSnapshot(next) : null;
      api?.renderer?.requestRender?.();
    };

    const timer = setInterval(poll, POLL_MS);
    timer.unref?.();
    api?.lifecycle?.onDispose?.(() => clearInterval(timer));

    api.slots.register({
      order: 900,
      slots: {
        // The argument is the slot context the host renders with, not the slot
        // props the type declares — `{ theme }`, live, so it is preferred over
        // the api's copy.
        sidebar_content: (context) => {
          const sessionID = currentSessionID(api, context, snapshot);
          const records = sessionRecords(snapshot, sessionID);
          const state = dispatchState({ hasFile, snapshot, panelVersion: version });
          debug(
            `tui panel: file=${file} mtime=${stamp} state=${state} ` +
              `session=${sessionID} records=${records.length}`
          );
          return renderPanel(
            {
              version,
              preset: settings.preset,
              subsystems,
              agents: panelAgents(settings, api?.state?.config),
              records,
              snapshotState: state,
              pluginVersion: snapshot?.pluginVersion ?? null,
              theme: context?.theme?.current ?? api?.theme?.current ?? {},
            },
            h
          );
        },
      },
    });

    debug(`tui panel registered (v${version}, preset ${settings.preset})`);
  },
};
