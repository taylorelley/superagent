/**
 * The Superagent panel, as a tree of OpenTUI elements.
 *
 * ## Why the element factory is an argument
 *
 * OpenTUI is not a dependency of this package and is not installed anywhere
 * this file can import from — the TUI host hands its own copy to plugins at
 * runtime (see `../tui/superagent-tui.js`). Taking `h` as an argument keeps
 * this module free of that machinery, so the layout is a pure function of its
 * inputs and can be tested in plain Node with a recording factory.
 *
 * ## What the panel is for
 *
 * The board injected into the conversation is written for the model, and under
 * the `latest` strategy it is stripped and rewritten every turn. None of it is
 * addressed to the human, and `/board` costs a model turn to read back. This
 * panel is the human's copy: always visible, always current, free.
 *
 * Colours only ever come from the caller's theme. Hardcoding one would look
 * deliberate on the theme it was picked for and broken on every other.
 */

import { truncate } from './board.js';

/**
 * Row budgets.
 *
 * The sidebar is a fixed column in someone else's layout, and a panel that
 * overflows it is silently clipped — the section that gets cut is the one at
 * the bottom, which here is the live one. So both lists are capped and say how
 * many they are hiding. The full roster is a `/preset` away; the running
 * dispatches are not.
 *
 * These are also the defaults for `agentRowLimit`/`dispatchRowLimit` below —
 * a caller can grow either at runtime (clicking "+N more") without ever
 * asking this function to render more than the sidebar can actually hold at
 * once; it is the caller's job to grow the limit one page at a time.
 */
export const MAX_AGENT_ROWS = 8;
export const MAX_DISPATCH_ROWS = 5;

/**
 * Objectives are one line in a narrow column, so they get very little room.
 * Measured against a real sidebar: past thirty characters the line wraps and
 * the panel loses its shape. Counted including the ellipsis, excluding the
 * two-space indent these lines are printed under.
 */
export const OBJECTIVE_MAX = 30;

/** `truncate` spends its budget before the ellipsis; a column includes it. */
const fit = (text, max) => truncate(text, max - 1);

/** A slot with no model pinned inherits the session's, which is worth saying. */
const INHERIT = 'inherit';

const STATE_COLOR = {
  running: 'info',
  completed: 'success',
  error: 'error',
  cancelled: 'textMuted',
};

const STATE_GLYPH = {
  running: '●',
  completed: '✓',
  error: '✗',
  cancelled: '○',
};

const onOff = (value) => (value ? 'on' : 'off');

/**
 * A model id, shortened for a column a few dozen characters wide.
 *
 * The provider prefix is dropped rather than truncated away from the right:
 * `anthropic/claude-…` tells you nothing you did not already know, while the
 * tail is the part that distinguishes one routed slot from another.
 */
export const shortModel = (id, max = 22) => {
  const raw = String(id ?? '').trim();
  if (!raw) return '';
  const tail = raw.slice(raw.lastIndexOf('/') + 1);
  return tail.length <= max ? tail : `…${tail.slice(tail.length - max + 1)}`;
};

/** Running first, then the most recently finished. */
const orderRecords = (records) =>
  [...records].sort((a, b) => {
    if ((a.state === 'running') !== (b.state === 'running')) return a.state === 'running' ? -1 : 1;
    return (b.endedAt ?? b.startedAt ?? 0) - (a.endedAt ?? a.startedAt ?? 0);
  });

/** Routed slots first: a pinned model is the part a reader cannot guess. */
const orderAgents = (agents) =>
  [...agents].sort((a, b) => Number(Boolean(b.model)) - Number(Boolean(a.model)));

export const renderPanel = (model, h) => {
  const {
    version = 'dev',
    preset = 'unknown',
    subsystems = {},
    agents = [],
    agentsExpanded = false,
    records = [],
    theme = {},
    snapshotState = 'ok',
    pluginVersion = null,
    agentRowLimit = MAX_AGENT_ROWS,
    dispatchRowLimit = MAX_DISPATCH_ROWS,
    onToggleAgents,
    onRevealMoreAgents,
    onRevealMoreDispatches,
  } = model ?? {};

  const muted = (content) => h.text({ fg: theme.textMuted }, [content]);

  /** A muted line the caller can click — accent instead of muted marks it as live. */
  const actionable = (content, handler) =>
    h.text({ fg: theme.accent, onMouseDown: handler }, [content]);

  /** A name on the left, a dimmer value on the right. */
  const pair = (left, right, rightColor = theme.textMuted) =>
    h.box({ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }, [
      h.text({ fg: theme.text }, [left]),
      h.text({ fg: rightColor }, [right]),
    ]);

  // Collapsed mode still owes the row budget: a preset routing more than
  // MAX_AGENT_ROWS slots would otherwise render every one of them unbounded.
  const collapsedAgents = agents.filter((agent) => agent.model).slice(0, MAX_AGENT_ROWS);
  const collapsedHidden = agents.length - collapsedAgents.length;

  const children = [
    // Identity. The version answers "did my update land", the preset answers
    // "why is it behaving like that" — both otherwise cost a turn to ask.
    h.box({ width: '100%', flexDirection: 'row', justifyContent: 'space-between' }, [
      h.text({ fg: theme.accent }, ['Superagent']),
      h.text({ fg: theme.textMuted }, [`v${version}`]),
    ]),
    muted(
      `${preset} · agents ${onOff(subsystems.agents)} · board ${onOff(subsystems.board)}` +
        (subsystems.council ? ' · council on' : ''),
    ),

    h.box(
      {
        width: '100%',
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: 1,
        onMouseDown: onToggleAgents,
      },
      [
        h.text({ fg: theme.accent }, ['Agents']),
        h.text({ fg: theme.textMuted }, [String(agents.length)]),
      ],
    ),
    ...(agents.length === 0
      ? [muted('none registered')]
      : agentsExpanded
        ? [
            ...orderAgents(agents)
              .slice(0, agentRowLimit)
              .map((agent) => pair(agent.name, shortModel(agent.model) || INHERIT)),
            ...(agents.length > agentRowLimit
              ? [actionable(`+${agents.length - agentRowLimit} more`, onRevealMoreAgents)]
              : []),
          ]
        : [
            ...collapsedAgents.map((agent) => pair(agent.name, shortModel(agent.model))),
            ...(collapsedHidden > 0
              ? [actionable(`+${collapsedHidden} collapsed`, onToggleAgents)]
              : []),
          ]),
  ];

  const running = records.filter((r) => r.state === 'running');
  children.push(
    h.box({ width: '100%', flexDirection: 'row', justifyContent: 'space-between', marginTop: 1 }, [
      h.text({ fg: theme.accent }, ['Dispatches']),
      h.text({ fg: theme.textMuted }, [
        records.length ? `${running.length}/${records.length}` : '—',
      ]),
    ]),
  );

  if (snapshotState === 'none') {
    children.push(muted('no snapshot yet — nothing dispatched'));
  } else if (snapshotState === 'incompatible') {
    children.push(muted('snapshot from a different plugin version'));
  } else if (snapshotState === 'version-mismatch') {
    children.push(muted(`server v${pluginVersion} ≠ panel v${version}`));
  } else if (!records.length) {
    children.push(muted('none this session'));
  } else {
    const ordered = orderRecords(records);
    for (const record of ordered.slice(0, dispatchRowLimit)) {
      const state = record.state ?? 'unknown';
      children.push(
        pair(
          `${STATE_GLYPH[state] ?? ''} ${record.agent ?? 'unknown'}`,
          `${state}${record.background ? ' (bg)' : ''}`,
          theme[STATE_COLOR[state] ?? 'textMuted'] ?? theme.textMuted,
        ),
      );
      // Detail lines only for what is still running. A finished dispatch is
      // one line of history; the one holding files right now is worth three.
      if (record.state === 'running') {
        children.push(
          h.text({ fg: theme.textMuted }, [`  ${fit(record.objective || '—', OBJECTIVE_MAX)}`]),
        );
        // Ownership is the one thing on the board a human cannot get anywhere
        // else, and it is what tells them two agents are about to collide.
        if (record.owns?.length) {
          children.push(
            h.text({ fg: theme.textMuted }, [
              `  owns ${fit(record.owns.join(', '), OBJECTIVE_MAX - 'owns '.length)}`,
            ]),
          );
        }
      }
    }
    if (ordered.length > dispatchRowLimit) {
      children.push(
        actionable(`+${ordered.length - dispatchRowLimit} more`, onRevealMoreDispatches),
      );
    }
  }

  // No border: the host's own sidebar sections do not draw one, and a box
  // around this one would read as an alien pane rather than another section.
  return h.box(
    {
      width: '100%',
      flexDirection: 'column',
      paddingTop: 1,
      paddingBottom: 1,
      paddingLeft: 1,
      paddingRight: 1,
    },
    children,
  );
};
