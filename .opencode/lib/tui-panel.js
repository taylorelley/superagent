/**
 * The Superagent panel, as a tree of OpenTUI elements.
 *
 * ## Why the element factory is an argument
 *
 * OpenTUI is not a dependency of this package and is not installed anywhere
 * this file can import from — the TUI host resolves its own copy for plugins
 * at runtime (see `../tui/superagent-tui.js`). Taking `h` as an argument keeps
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
 * It answers, top to bottom, what the plan is, what the main agent is doing,
 * and what each subagent is doing — the things the main pane either scrolls
 * away or never shows (a subagent's own tool calls live in its child session).
 * Configuration is one footer line: it rarely changes, so it earns no more.
 *
 * Colours only ever come from the caller's theme. Hardcoding one would look
 * deliberate on the theme it was picked for and broken on every other.
 */

import { truncate } from './board.js';
import { formatElapsed } from './tui-activity.js';

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

/**
 * Fit text to a column of `max` characters, ellipsis included. `truncate`
 * spends its budget before the ellipsis, so it gets one less — but only when
 * truncating: text exactly `max` long already fits.
 */
const fit = (text, max) => {
  const clean = truncate(text, Number.MAX_SAFE_INTEGER);
  return clean.length <= max ? clean : truncate(clean, Math.max(0, max - 1));
};

/** A slot with no model pinned inherits the session's, which is worth saying. */
const INHERIT = 'inherit';

/**
 * The sidebar's text column, in characters. Measured in OpenCode 2.2.5's TUI:
 * the content area inside the panel's padding is 35 wide, and a row whose two
 * halves add up to more runs them together (`10 agentsv0.1.0`) rather than
 * wrapping. A row's left half is fitted to whatever its right half leaves.
 */
export const PANEL_WIDTH = 35;

/**
 * Detail lines (live tool, ownership, conflicts) are only drawn for this many
 * running subagents. Each can take four lines, and the sidebar is short.
 */
export const MAX_DETAILED_RUNNING = 3;

const STATE_COLOR = {
  idle: 'textMuted',
  running: 'info',
  completed: 'success',
  error: 'error',
  cancelled: 'textMuted',
};

const STATE_GLYPH = {
  running: '●', // drawn as a SPINNER frame; kept so `running` counts as known
  completed: '✓',
  error: '✗',
  cancelled: '○',
};

/**
 * A running row's glyph turns a quarter each second. The entry file already
 * repaints once a second while anything runs (so the timers tick), and the
 * frame is derived from the same `now`, so this costs no extra timer and the
 * panel stays a pure function of its inputs.
 */
export const SPINNER = ['◐', '◓', '◑', '◒'];
export const runningGlyph = (now) => {
  const second = Math.floor(Number(now) / 1000);
  return SPINNER[Number.isFinite(second) ? ((second % 4) + 4) % 4 : 0];
};

/**
 * OpenTUI's `TextAttributes.BOLD` (from `@opentui/core`). It is a terminal
 * SGR bit and stable across OpenTUI versions; inlining it saves importing a
 * third host module for one number. A host that ignores the prop renders the
 * text plain, which is the panel as it was.
 */
const BOLD = 1;

/**
 * How much of a `width`-column bar a plan's progress fills. Never full until
 * every step is done, never empty once one is, so the bar cannot round away
 * the difference the count beside it is making.
 */
export const progressBar = (done, total, width) => {
  const room = Math.max(0, Math.floor(width));
  if (!(total > 0) || room === 0) return { filled: 0, empty: room };
  const ratio = Math.min(1, Math.max(0, done / total));
  let filled = Math.round(ratio * room);
  if (ratio > 0 && filled === 0) filled = 1;
  if (ratio < 1 && filled === room) filled = room - 1;
  return { filled, empty: room - filled };
};

/**
 * Flatten an OpenCode V2 TUI theme into the handful of colours the panel uses.
 *
 * V2 themes are semantic tokens (`text.base`, `text.feedback.success.base`,
 * `text.action.primary.base`, …). The panel only ever needs these seven, and
 * resolving them in one place keeps `renderPanel` independent of the host's
 * theme shape. A missing token resolves to undefined, which OpenTUI renders
 * in the default foreground — never a hardcoded colour.
 */
export const panelTheme = (theme) => {
  const text = theme?.text ?? {};
  const feedback = text.feedback ?? {};
  const base = (token) => token?.base ?? token;
  return {
    text: text.base,
    textMuted: text.muted,
    accent: base(text.action?.primary) ?? base(feedback.info) ?? text.base,
    info: base(feedback.info),
    success: base(feedback.success),
    error: base(feedback.error),
    warning: base(feedback.warning),
  };
};

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

/**
 * Join the board's records to the host's child sessions.
 *
 * A record carries its child's session id once the server has linked it; a
 * record that was never linked (an older server, a missed event) falls back
 * to the running child with the same agent and title. Running children no
 * record accounts for — the board switched off, say — still get a row, since
 * "something is running" is never noise.
 */
const joinChildren = (records, children) => {
  const byID = new Map(children.map((child) => [child.id, child]));
  const used = new Set();
  // Only running records join a child: a finished row needs no live data, and
  // a child resumed by a follow-up dispatch is still named by the finished
  // record that first started it — that record must not claim it.
  const rows = records.map((record) => {
    if (record.state !== 'running') return { ...record };
    let child = record.childSessionID ? byID.get(record.childSessionID) : undefined;
    if (child && used.has(child.id)) child = undefined;
    if (!child) {
      child = children.find(
        (c) =>
          !used.has(c.id) &&
          c.state === 'running' &&
          c.agent === record.agent &&
          // The board stores objectives truncated and whitespace-collapsed.
          truncate(c.title, 80) === (record.objective ?? ''),
      );
    }
    if (child) used.add(child.id);
    return { ...record, child };
  });
  for (const child of children) {
    if (used.has(child.id) || child.state !== 'running') continue;
    rows.push({
      agent: child.agent ?? 'subagent',
      objective: child.title ?? '',
      state: 'running',
      startedAt: child.since ?? undefined,
      child,
      unrecorded: true,
    });
  }
  return rows;
};

const elapsedOf = (record, now) => {
  const start = record.startedAt;
  if (typeof start !== 'number') return '';
  const end = record.state === 'running' ? now : record.endedAt;
  return typeof end === 'number' ? formatElapsed(end - start) : '';
};

export const renderPanel = (model, h) => {
  const {
    version = 'dev',
    preset = 'unknown',
    subsystems = {},
    agents = [],
    agentsExpanded = false,
    records = [],
    children = [],
    main = null,
    plan = null,
    now = Date.now(),
    theme = {},
    snapshotState = 'ok',
    pluginVersion = null,
    updateAvailable = false,
    latestVersion = null,
    agentRowLimit = MAX_AGENT_ROWS,
    dispatchRowLimit = MAX_DISPATCH_ROWS,
    onToggleAgents,
    onRevealMoreAgents,
    onRevealMoreDispatches,
  } = model ?? {};

  const line = (content, fg = theme.textMuted) => h.text({ fg }, [content]);
  const muted = (content) => line(content);
  /**
   * A row's detail lines hang off it on a tree guide: `├` for all but the
   * last, `└` for the last. The guide is the same two columns the indent
   * was, so the text budget is unchanged.
   */
  const details = (items) =>
    items.map(({ text: content, fg = theme.textMuted }, i) =>
      h.box({ width: '100%', flexDirection: 'row' }, [
        h.text({ fg: theme.textMuted }, [i === items.length - 1 ? '└ ' : '├ ']),
        h.text({ fg }, [fit(content, OBJECTIVE_MAX)]),
      ]),
    );

  /** A line the caller can click — accent instead of muted marks it as live. */
  const actionable = (content, handler) =>
    h.text({ fg: theme.accent, onMouseDown: handler }, [content]);

  /**
   * A name on the left, a dimmer value on the right. The left half is fitted
   * to what the right half leaves, with a space between them.
   */
  const pair = (left, right, leftColor = theme.text, rightColor = theme.textMuted, props = {}) => {
    const room = PANEL_WIDTH - (right ? right.length + 1 : 0);
    return h.box(
      { width: '100%', flexDirection: 'row', justifyContent: 'space-between', ...props },
      [h.text({ fg: leftColor }, [fit(left, room)]), h.text({ fg: rightColor }, [right])],
    );
  };

  /**
   * A section header: bold title, a hairline rule across the gap, the count
   * on the right. The rule is sized to the column so the row never wraps.
   * `bar`, when given, turns the rule into a progress bar — filled in the
   * success colour, the rest left as rule.
   */
  const header = (title, right = '', first = false, props = {}, bar = null) => {
    const tail = right ? right.length + 1 : 0;
    const name = fit(title, PANEL_WIDTH - tail);
    const gap = Math.max(0, PANEL_WIDTH - name.length - tail - 1);
    const rule = [];
    if (gap > 0 && bar) {
      const { filled, empty } = progressBar(bar.done, bar.total, gap);
      rule.push(h.text({ fg: theme.success }, [` ${'━'.repeat(filled)}`]));
      rule.push(h.text({ fg: theme.textMuted }, [`${'─'.repeat(empty)}${right ? ' ' : ''}`]));
    } else if (gap > 0) {
      rule.push(h.text({ fg: theme.textMuted }, [` ${'─'.repeat(gap)}${right ? ' ' : ''}`]));
    }
    return h.box(
      { width: '100%', flexDirection: 'row', ...(first ? {} : { marginTop: 1 }), ...props },
      [
        h.text({ fg: theme.accent, attributes: BOLD }, [name]),
        ...rule,
        ...(right ? [h.text({ fg: theme.textMuted }, [right])] : []),
      ],
    );
  };

  const out = [];
  let first = true;
  const section = (title, right, props, bar) => {
    out.push(header(title, right, first, props, bar));
    first = false;
  };

  // Plan: which plan this session is executing, and how far through it is.
  if (plan) {
    section(
      'Plan',
      plan.total ? `${plan.done}/${plan.total}` : '',
      {},
      plan.total ? { done: plan.done ?? 0, total: plan.total } : null,
    );
    out.push(muted(fit(plan.name ?? '', PANEL_WIDTH)));
    if (plan.current) out.push(line(`▸ ${fit(plan.current, OBJECTIVE_MAX)}`, theme.text));
  }

  // Main: the agent the human is talking to. The skill line in the main pane
  // scrolls away; this one stays while the skill is shaping behaviour.
  if (main) {
    section(main.skill ? `Main · ${main.skill}` : 'Main');
    if (main.state === 'running') {
      out.push(
        pair(
          `${runningGlyph(now)} ${main.current ?? 'working'}`,
          typeof main.since === 'number' ? formatElapsed(now - main.since) : '',
          theme.info,
        ),
      );
    } else {
      out.push(muted('idle'));
    }
  }

  // Subagents: the board's ledger, joined to what each child is doing now.
  const rows = orderRecords(joinChildren(records, children));
  const running = rows.filter((r) => r.state === 'running');
  section('Subagents', rows.length ? `${running.length}/${rows.length}` : '—');

  if (snapshotState === 'incompatible') {
    out.push(muted('snapshot from a different plugin version'));
  } else if (snapshotState === 'version-mismatch') {
    out.push(muted(`server v${pluginVersion} ≠ panel v${version}`));
  }
  if (!rows.length) {
    if (snapshotState === 'none') out.push(muted('no snapshot yet — nothing dispatched'));
    else if (snapshotState === 'ok') out.push(muted('none this session'));
  } else {
    let detailed = 0;
    for (const record of rows.slice(0, dispatchRowLimit)) {
      const state = record.state ?? 'unknown';
      const color = theme[STATE_COLOR[state] ?? 'textMuted'] ?? theme.textMuted;
      const label = record.objective
        ? `${record.agent ?? 'unknown'} · ${record.objective}`
        : (record.agent ?? 'unknown');
      const timer = elapsedOf(record, now);
      const glyph = state === 'running' ? runningGlyph(now) : (STATE_GLYPH[state] ?? '·');
      out.push(
        pair(
          `${glyph} ${label}`,
          // A state without a glyph is one this panel does not know, so it is
          // named rather than silently drawn like a known one.
          [record.background ? 'bg' : '', STATE_GLYPH[state] ? '' : state, timer]
            .filter(Boolean)
            .join(' '),
          theme.text,
          color,
        ),
      );

      if (state === 'running') {
        // Detail lines only for the first few running rows: each is worth
        // up to three more lines, and the sidebar is short.
        if (detailed >= MAX_DETAILED_RUNNING) continue;
        detailed += 1;
        const items = [];
        if (record.child?.current) items.push({ text: record.child.current });
        // Ownership is the one thing on the board a human cannot get anywhere
        // else, and it is what tells them two agents are about to collide.
        if (record.owns?.length) items.push({ text: `owns ${record.owns.join(', ')}` });
        if (record.conflicts?.length) {
          items.push({ text: `⚠ overlaps ${record.conflicts.join(', ')}`, fg: theme.warning });
        }
        out.push(...details(items));
      } else if (state === 'error' && record.result) {
        // The row's ✗ and the error colour already say it failed.
        out.push(...details([{ text: record.result, fg: theme.error }]));
      } else if (state === 'completed' && record.result) {
        out.push(...details([{ text: record.result }]));
      }
    }
    if (rows.length > dispatchRowLimit) {
      out.push(actionable(`+${rows.length - dispatchRowLimit} more`, onRevealMoreDispatches));
    }
  }

  // Configuration, last and smallest. A persistent surface for "an update
  // exists" — the toast is best-effort, this line is the guaranteed notice.
  if (updateAvailable) {
    out.push(
      h.text({ fg: theme.accent, marginTop: 1 }, [
        `⬆ v${latestVersion ?? '?'} available — run /update install`,
      ]),
    );
  }
  // Name and version together on the left (they answer "which plugin, did my
  // update land"); preset and roster size on the right. That way round fits
  // the 35-column sidebar without truncating either half.
  // The name in bold accent makes the footer read as a signature rather than
  // one more muted row, at no cost in columns (the sidebar has none spare).
  // A spacer, not space-between, keeps every part a direct child of the
  // clickable box.
  const roster = subsystems.agents === false ? '' : ` · ${agents.length} agents`;
  const brand = 'Superagent';
  const tag = ` v${version}`;
  out.push(
    h.box(
      {
        width: '100%',
        flexDirection: 'row',
        marginTop: updateAvailable ? 0 : 1,
        onMouseDown: onToggleAgents,
      },
      [
        h.text({ fg: theme.accent, attributes: BOLD }, [brand]),
        h.text({ fg: theme.textMuted }, [tag]),
        h.box({ flexGrow: 1 }, []),
        h.text({ fg: theme.textMuted }, [
          fit(`${preset}${roster}`, Math.max(0, PANEL_WIDTH - brand.length - tag.length - 1)),
        ]),
      ],
    ),
  );
  // Only the unusual states: a subsystem switched off explains behaviour the
  // reader would otherwise expect; the defaults being on is not news.
  const unusual = [
    subsystems.agents === false ? 'agents off' : '',
    subsystems.board === false ? 'board off' : '',
    subsystems.council ? 'council on' : '',
  ].filter(Boolean);
  if (unusual.length) out.push(muted(unusual.join(' · ')));

  // The roster, on request: clicking the footer toggles it.
  if (agentsExpanded) {
    if (!agents.length) {
      out.push(muted('  none registered'));
    } else {
      // On the same tree guide as a row's details. Not an indent: OpenCode
      // 2.2.5 trims leading spaces from a text inside a row box, which left
      // the names flush with the headers and the "+N more" line indented.
      const shown = orderAgents(agents).slice(0, agentRowLimit);
      const more = agents.length > agentRowLimit;
      shown.forEach((agent, i) => {
        const guide = i === shown.length - 1 && !more ? '└ ' : '├ ';
        out.push(pair(`${guide}${agent.name}`, shortModel(agent.model) || INHERIT));
      });
      if (more) {
        out.push(actionable(`└ +${agents.length - agentRowLimit} more`, onRevealMoreAgents));
      }
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
    out,
  );
};
