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
import { renderPanel, MAX_AGENT_ROWS, MAX_DISPATCH_ROWS } from '../lib/tui-panel.js';
import { snapshotPath, readSnapshot, sessionRecords, readVersion } from '../lib/tui-snapshot.js';
import { debug, warn } from '../lib/log.js';

export { readVersion };

/** How often the board snapshot is re-checked. Slim uses the same cadence. */
const POLL_MS = 1000;

const SOLID_SPECIFIERS = [
  `opentui:runtime-module:${encodeURIComponent('@opentui/solid')}`,
  '@opentui/solid',
];

/**
 * Candidate names for a node-removal function on the OpenTUI module.
 *
 * `createElement`/`setProp`/`insert` are confirmed exports (that is how the
 * panel has always rendered), but nothing here has ever needed to remove a
 * node, so no removal export has ever been confirmed. These are tried, in
 * order, as a best effort — see `elementFactory`'s `unmount` and
 * "Still unverified" in docs/superagent.md.
 */
const REMOVE_EXPORT_NAMES = ['remove', 'removeChild', 'removeNode', 'unmount'];

/**
 * Wrap OpenTUI's imperative element API in the `{ box, text, mount, unmount }`
 * the panel wants.
 *
 * `mount`/`unmount` are the low-level primitives the `tui()` entry's
 * `repaint()` function uses to patch an already-mounted root node's children
 * in place, instead of building a disconnected tree every poll tick and
 * hoping the host will pick it up on its own. `unmount` is `null` when the
 * module exposes nothing under any of `REMOVE_EXPORT_NAMES` — in that case
 * in-place repaint is disabled and `repaint()` degrades to the single
 * initial render this panel has always done.
 */
export const elementFactory = (mod) => {
  const { createElement, setProp, insert } = mod ?? {};
  const removeExport = REMOVE_EXPORT_NAMES.map((name) => mod?.[name]).find(
    (fn) => typeof fn === 'function',
  );

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
    mount: (parent, child) => insert(parent, child),
    unmount: removeExport ? (parent, child) => removeExport(parent, child) : null,
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
  if (!snapshot.pluginVersion) {
    // The server's own readVersion() failed (e.g. an unreadable package.json
    // in a broken install), so a real skew here would go undetected. Not
    // worth surfacing to the user over a working panel, but worth a trace.
    debug('tui panel: snapshot has no pluginVersion; skipping the version-skew check');
  }
  return 'ok';
};

/**
 * Runtime UI state for the panel's click affordances.
 *
 * A tiny state machine, not part of `renderPanel` (which stays a pure
 * function of its inputs): the Agents section's expanded/collapsed flag and
 * both lists' row limits live here instead, seeded once from config and
 * mutated only by a click. `onChange` is called after every mutation so the
 * caller can drive a repaint — in practice the `tui()` entry's own
 * `repaint()` — the same way a poll tick does, with no separate refresh path
 * to keep in sync.
 *
 * Exported and tested on its own, the same way `panelAgents`/`dispatchState`
 * are: the click handlers this returns end up wired into a live OpenTUI node
 * that only exists once the host actually renders the panel, so the state
 * machine itself is what unit tests can exercise without a terminal.
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

/**
 * Keeps one root node alive across repaints and patches its child in place.
 *
 * The reason this exists at all: `requestRender()` repaints whatever node
 * tree the host already has, but nothing confirms the host re-invokes
 * `sidebar_content` to hand it a *new* tree on every poll tick or click (see
 * the `tui()` entry's own comment, and docs/superagent.md). So the panel
 * mounts one root the first time it is asked for content, and from then on
 * repaints by swapping that root's child, using `h.mount`/`h.unmount` — the
 * same primitives `elementFactory` exposes.
 *
 * Isolated from `tui()` so it can be exercised with a recording `h`, exactly
 * like `elementFactory` itself already is — no OpenTUI or terminal needed.
 */
export const createRootRepainter = (h) => {
  let root = null;
  let mountedChild = null;

  return {
    get root() {
      return root;
    },
    /** Create the root once, and return it every time after. */
    ensureRoot: () => {
      if (!root) root = h.box({ width: '100%', flexDirection: 'column' }, []);
      return root;
    },
    /**
     * Swap the mounted child for `next`. Returns whether it actually did —
     * false before `ensureRoot()` has run, and false after the first paint
     * when `h.unmount` is unavailable: swapping without a way to remove the
     * old child would only stack a new tree on top of it, which is worse
     * than leaving the first, correct render alone.
     */
    patch: (next) => {
      if (!root) return false;
      if (mountedChild && !h.unmount) return false;
      if (mountedChild) h.unmount(root, mountedChild);
      h.mount(root, next);
      mountedChild = next;
      return true;
    },
  };
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
        'could not load the OpenTUI element factory; the Superagent sidebar panel is not available',
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
    let theme = {};

    /**
     * The panel does not actually go live just by calling
     * `api.renderer.requestRender()` on its own: that repaints whatever node
     * tree the host already has, but nothing here has confirmed the host ever
     * calls `sidebar_content` again after the first mount — and observed
     * behaviour says it does not (the panel only refreshes when something
     * else, like switching to a subagent view and back, forces a remount). So
     * instead of trusting a re-invocation that may never come, `repainter`
     * keeps its own root node alive and this repaints by patching that root's
     * child in place, on every poll tick and every click. See
     * docs/superagent.md, "The sidebar panel" for the full story and its
     * "Still unverified" list for what this still needs confirming against a
     * live host.
     */
    const repainter = createRootRepainter(h);

    if (!h.unmount) {
      warn(
        'tui panel: the OpenTUI module exposes no node-removal function this plugin ' +
          'recognizes, so live in-place repaint is disabled; the panel will only refresh ' +
          'when the host itself re-invokes sidebar_content (e.g. switching views). ' +
          'See docs/superagent.md.',
      );
    }

    const repaint = () => {
      if (!repainter.root) return;
      const sessionID = currentSessionID(api, undefined, snapshot);
      const records = sessionRecords(snapshot, sessionID);
      const state = dispatchState({ hasFile, snapshot, panelVersion: version });
      debug(
        `tui panel: file=${file} mtime=${stamp} state=${state} ` +
          `session=${sessionID} records=${records.length}`,
      );
      const next = renderPanel(
        {
          version,
          preset: settings.preset,
          subsystems,
          agents: panelAgents(settings, api?.state?.config),
          records,
          snapshotState: state,
          pluginVersion: snapshot?.pluginVersion ?? null,
          updateAvailable: snapshot?.updateAvailable ?? false,
          latestVersion: snapshot?.latestVersion ?? null,
          theme,
          ...interactions.state,
          onToggleAgents: interactions.toggleAgents,
          onRevealMoreAgents: interactions.revealMoreAgents,
          onRevealMoreDispatches: interactions.revealMoreDispatches,
        },
        h,
      );

      if (repainter.patch(next)) api?.renderer?.requestRender?.();
    };

    const interactions = createPanelInteractions(settings.tui?.agents?.expanded, () => repaint());

    // Only re-parse when the file actually moved, and only repaint when
    // something changed: this runs for the life of the session, next to a
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
      repaint();
    };

    const timer = setInterval(poll, POLL_MS);
    timer.unref?.();
    api?.lifecycle?.onDispose?.(() => clearInterval(timer));

    api.slots.register({
      order: 900,
      slots: {
        // The argument is the slot context the host renders with, not the slot
        // props the type declares — `{ theme }`, live, so it is preferred over
        // the api's copy. Captured into the outer `theme` variable so `repaint()`
        // can use it from a poll tick or a click, neither of which get a context.
        sidebar_content: (context) => {
          theme = context?.theme?.current ?? api?.theme?.current ?? {};
          const root = repainter.ensureRoot();
          repaint();
          return root;
        },
      },
    });

    debug(`tui panel registered (v${version}, preset ${settings.preset})`);
  },
};
