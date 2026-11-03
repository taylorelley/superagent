/**
 * The job board: a ledger of dispatches, and the ownership check between them.
 *
 * ## What this is not
 *
 * oh-my-opencode-slim's board is built around polling — a wake scheduler, a
 * liveness reconciler, a "stopped, unreconciled" state meaning "the session
 * ended but we never saw a result". That design exists because its orchestrator
 * has to discover completion for itself.
 *
 * OpenCode does not work that way. A background `subagent` call notifies the
 * parent session when the child finishes, and the tool's own output tells the
 * model in as many words: "You will be notified automatically when it
 * finishes." (See docs/superagent.md for the source references.)
 *
 * So there is no poller here, and no reconciliation state machine. Building one
 * would duplicate machinery OpenCode already has, and instruct the model to do
 * the exact thing its tools tell it not to.
 *
 * ## What this is
 *
 * Two things OpenCode does not provide:
 *
 *   1. **Ownership enforcement.** Nothing stops two concurrent write-capable
 *      dispatches editing the same file, where both succeed and one silently
 *      loses. Conflicting claims are detected at dispatch time and the losing
 *      prompt is told about it.
 *
 *   2. **A ledger.** Over a long session the orchestrator loses track of what
 *      it launched. A compact snapshot in context is cheaper than re-deriving
 *      it from scrollback.
 */

import { parseOwnership, findConflicts, conflictNotice } from './ownership.js';
import { debug } from './log.js';
import { withContent } from './bootstrap.js';

export const BOARD_MARKER = '<SUPERAGENT_JOB_BOARD>';

/** sessionID → { records: Map<callID, record> } */
const boards = new Map();

export const resetBoards = () => boards.clear();

const boardFor = (sessionID) => {
  if (!boards.has(sessionID)) boards.set(sessionID, { records: new Map() });
  return boards.get(sessionID);
};

export const truncate = (text, max = 600) => {
  const clean = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
};

/**
 * Record a dispatch and check it against what is already running.
 *
 * Called from the `subagent` tool's `execute.before` hook, so it can annotate
 * the outgoing prompt. `args` is the tool input (`agent`, `description`,
 * `prompt`, `background`, `sessionID`). Mutates `args.prompt` when there is a
 * conflict and enforcement is on.
 */
export const onDispatch = (sessionID, callID, args, settings) => {
  if (!settings?.board?.enabled || !sessionID || !callID) return;

  const board = boardFor(sessionID);
  const ownership = parseOwnership(args?.prompt);

  const record = {
    id: callID,
    agent: args?.agent ?? args?.subagent_type ?? 'unknown',
    objective: truncate(args?.description, 80),
    state: 'running',
    background: args?.background === true,
    ownership,
    startedAt: Date.now(),
    result: null,
    // A follow-up to an existing subagent names its child session up front,
    // and no `session.created` fires for a session that already exists.
    ...(typeof args?.sessionID === 'string' && args.sessionID
      ? { childSessionID: args.sessionID }
      : {}),
  };

  if (ownership?.write?.length && settings.board.enforceOwnership === 'warn') {
    const running = [...board.records.values()].filter((r) => r.state === 'running');
    const conflicts = findConflicts(ownership, running);
    if (conflicts.length) {
      debug(`ownership conflict for ${record.agent}: ${conflicts.length} overlapping dispatch(es)`);
      record.conflicts = conflicts.map((c) => c.id);
      args.prompt = conflictNotice(conflicts) + args.prompt;
    }
  }

  board.records.set(callID, record);
};

/** The plain text of a V2 tool result (`{ content: [{ type: 'text', text }] }`). */
export const resultText = (result) => {
  if (typeof result === 'string') return result;
  if (typeof result?.output === 'string') return result.output;
  const content = Array.isArray(result?.content) ? result.content : [];
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
};

/**
 * A `subagent` result without its envelope. OpenCode 2 wraps the child's
 * answer as `<subagent sessionID="…" state="completed">…</subagent>`
 * (confirmed against 2.2.5); the wrapper is bookkeeping, the body is the
 * answer a human wants to see.
 */
export const unwrapSubagent = (text) =>
  String(text ?? '')
    .replace(/^\s*<subagent\b[^>]*>\s*/, '')
    .replace(/\s*<\/subagent>\s*$/, '');

/** The child session a background dispatch reported, if it reported one. */
const BACKGROUND_SESSION = /\(sessionID:\s*([^)\s]+)\)/;
export const backgroundSessionID = (result, args) => {
  const metadata = result?.metadata ?? {};
  for (const key of ['sessionID', 'sessionId', 'childSessionID', 'jobId']) {
    if (typeof metadata[key] === 'string' && metadata[key]) return metadata[key];
  }
  if (typeof result?.structured?.sessionID === 'string') return result.structured.sessionID;
  // The tool's text says "working in the background (sessionID: …)".
  const match = resultText(result).match(BACKGROUND_SESSION);
  if (match) return match[1];
  // Continuing an existing child names it in the input.
  return typeof args?.sessionID === 'string' ? args.sessionID : undefined;
};

/**
 * Record a dispatch's outcome.
 *
 * Called from the `subagent` tool's `execute.after` hook with its V2 event:
 * `{ status: 'completed', result }` or `{ status: 'error', error }`. A
 * background dispatch has not finished — the tool returns as soon as the
 * child starts — so it stays `running`, and the child session id is kept to
 * match up the completion event later.
 */
export const onDispatchResult = (sessionID, callID, outcome, settings) => {
  if (!settings?.board?.enabled) return;

  const record = boards.get(sessionID)?.records.get(callID);
  if (!record) return;

  if (outcome?.status === 'error') {
    record.state = 'error';
    record.endedAt = Date.now();
    record.result = truncate(outcome.error?.message ?? 'failed');
    return;
  }

  const result = outcome?.result ?? outcome;
  if (record.background) {
    const child = backgroundSessionID(result, outcome?.input);
    if (child) {
      record.childSessionID = child;
      return;
    }
  }

  record.state = 'completed';
  record.endedAt = Date.now();
  record.result = truncate(unwrapSubagent(resultText(result)));
};

/**
 * Mark a background dispatch finished, from a session lifecycle event.
 *
 * Returns whether anything changed, so callers with work to do afterwards —
 * projecting the board to the TUI snapshot, say — can skip it when nothing did.
 */
export const TERMINAL_EVENTS = {
  'session.execution.succeeded': 'completed',
  'session.execution.failed': 'error',
  'session.execution.interrupted': 'cancelled',
  'session.deleted': 'cancelled',
};

export const onSessionEvent = (type, sessionID, data, settings) => {
  if (!sessionID) return false;
  // A new child session links to the dispatch that started it (see
  // `onChildCreated`); `data` is the event payload.
  if (type === 'session.created') {
    return onChildCreated(data?.parentID, sessionID, data?.agent, data?.title, settings);
  }
  const terminal = TERMINAL_EVENTS;
  const state = terminal[type];
  if (!state) return false;

  let changed = false;
  for (const board of boards.values()) {
    for (const record of board.records.values()) {
      if (record.childSessionID === sessionID && record.state === 'running') {
        record.state = state;
        record.endedAt = Date.now();
        changed = true;
      }
    }
  }

  // `boards` lives as long as the process, so a deleted session's ledger would
  // otherwise be retained — and scanned — forever. Done after the transitions
  // above so a deleted child still settles its parent's record.
  if (type === 'session.deleted') changed = boards.delete(sessionID) || changed;

  return changed;
};

/**
 * The board as plain data, for the TUI panel.
 *
 * A projection of the same records `renderBoard` formats, not a second ledger:
 * the panel is a different audience (a human, live, in the sidebar) but it must
 * never be able to disagree with what the model is told. Every session this
 * process knows about is included, because the panel is keyed by the session
 * the user is looking at and the plugin cannot know which one that is.
 */
export const boardSnapshots = () => {
  const out = {};
  for (const [sessionID, board] of boards.entries()) {
    if (board.records.size === 0) continue;
    const records = [...board.records.values()];
    out[sessionID] = {
      // Derived from the records rather than read off the clock: the snapshot
      // writer skips a write when the bytes are unchanged, and a wall-clock
      // stamp would make every board look different from the last one.
      updatedAt: Math.max(...records.map((r) => r.endedAt ?? r.startedAt ?? 0), 0),
      records: records.map((r) => ({
        agent: r.agent,
        objective: r.objective,
        state: r.state,
        background: r.background === true,
        owns: r.ownership?.write ?? [],
        startedAt: r.startedAt,
        ...(r.endedAt ? { endedAt: r.endedAt } : {}),
        // The child session, so the panel can join a record to the host's
        // live view of what that subagent is doing.
        ...(r.childSessionID ? { childSessionID: r.childSessionID } : {}),
        // What came back, one line's worth: the panel shows it under a
        // finished row, so a human can see an outcome without scrolling.
        ...(r.result ? { result: truncate(r.result, 120) } : {}),
        // Which running dispatches this one overlapped when it started — the
        // collision the human most needs to see, by agent name.
        ...(r.conflicts?.length
          ? {
              conflicts: r.conflicts.map((id) => board.records.get(id)?.agent ?? 'unknown'),
            }
          : {}),
      })),
    };
  }
  return out;
};

/**
 * Link a dispatch to the child session it started.
 *
 * Background dispatches report their child in the tool result; foreground
 * ones only reveal it through `session.created`, whose payload carries the
 * `parentID`, the `agent` and — as its title — the dispatch description
 * (confirmed against OpenCode 2.2.5). The oldest still-running, still-unlinked
 * record in the parent with the same agent and objective is the match.
 *
 * Returns whether a record was linked.
 */
export const onChildCreated = (parentID, childID, agent, title, settings) => {
  if (!settings?.board?.enabled || !parentID || !childID) return false;
  const board = boards.get(parentID);
  if (!board) return false;
  const objective = truncate(title, 80);
  const candidates = [...board.records.values()].filter(
    (r) => r.state === 'running' && !r.childSessionID && (!agent || r.agent === agent),
  );
  // Agent and title must both match: a lone running dispatch is not evidence
  // that an unrelated child session (another plugin's, say) belongs to it.
  const match = candidates.find((r) => r.objective === objective);
  if (!match) return false;
  match.childSessionID = childID;
  return true;
};

/** Render the board, or null when there is nothing worth showing. */
export const renderBoard = (sessionID) => {
  const board = boards.get(sessionID);
  if (!board || board.records.size === 0) return null;

  const records = [...board.records.values()];
  const running = records.filter((r) => r.state === 'running');

  const lines = [
    BOARD_MARKER,
    // Self-identifying because of where it lands. The snapshot is appended to
    // the last user message (the transform hook offers nowhere better), so a
    // model that does not know better reads it as something the human typed.
    // Observed: a model asked about the board replied that it "is user-supplied
    // text, not injected context" and declined to use it.
    'Maintained automatically by the Superagent plugin. Your human partner did',
    'not write this — it is the live record of subagents you have dispatched in',
    'this session.',
    '',
    `Dispatched this session: ${records.length} (${running.length} still running)`,
    '',
    '| Agent | Objective | State | Owns |',
    '|---|---|---|---|',
    ...records.map(
      (r) =>
        `| ${r.agent} | ${r.objective || '—'} | ${r.state}${r.background ? ' (bg)' : ''} | ${
          r.ownership?.write?.length ? r.ownership.write.join(', ') : '—'
        } |`,
    ),
  ];

  const unowned = running.filter((r) => !r.ownership);
  if (unowned.length) {
    lines.push(
      '',
      `${unowned.length} running dispatch(es) declared no file ownership. If any of`,
      'them writes, you cannot detect a collision — declare ownership when you',
      'dispatch write-capable work.',
    );
  }

  lines.push('</SUPERAGENT_JOB_BOARD>');
  return lines.join('\n');
};

/**
 * Attach the board snapshot to the last user message of a model request.
 *
 * `messages` is the V2 `context` hook's transcript (`{ role, content }`), and
 * `sessionID` comes from the hook event — V2 says which session a request is
 * for, so identity no longer has to be guessed from the messages. Changes made
 * here only affect the outgoing request, so under the `latest` strategy any
 * snapshot already in the transcript — another plugin's, or one carried in
 * from history — is stripped first: the board is a live view, and a stale copy
 * invites the model to act on an old state.
 */
export const injectBoard = (messages, sessionID, settings) => {
  if (!settings?.board?.enabled || !Array.isArray(messages) || !messages.length) return false;
  if (!sessionID) return false;

  const isSnapshot = (part) =>
    part?.type === 'text' &&
    typeof part.text === 'string' &&
    part.text.trimStart().startsWith(BOARD_MARKER);

  if (settings.board.strategy === 'latest') {
    messages.forEach((message, index) => {
      if (!Array.isArray(message?.content) || !message.content.some(isSnapshot)) return;
      withContent(
        messages,
        index,
        message.content.filter((part) => !isSnapshot(part)),
      );
    });
  }

  const snapshot = renderBoard(sessionID);
  if (!snapshot) return false;

  let index = -1;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user' && messages[i].content?.length) {
      index = i;
      break;
    }
  }
  if (index === -1) return false;

  const target = messages[index];
  // Leading blank line: some providers join text parts with no separator.
  const text = `\n\n${snapshot}`;
  if (
    settings.board.strategy !== 'latest' &&
    target.content.some((p) => p?.type === 'text' && p.text === text)
  ) {
    return false;
  }

  withContent(messages, index, [...target.content, { type: 'text', text }]);
  return true;
};

/**
 * Link a dispatch to its child directly, when the host says which child a
 * dispatch started. Claude Code's `agent.spawn` answers with the subagent's id,
 * so no title matching is needed there.
 */
export const linkChild = (sessionID, callID, childID) => {
  const record = boards.get(sessionID)?.records.get(callID);
  if (!record || !childID) return false;
  record.childSessionID = childID;
  return true;
};

/** Settle a dispatch that never started — refused by a hook or by the host. */
export const failDispatch = (sessionID, callID, reason) => {
  const record = boards.get(sessionID)?.records.get(callID);
  if (!record) return false;
  record.state = 'error';
  record.endedAt = Date.now();
  record.result = truncate(reason ?? 'failed');
  return true;
};

/**
 * Settle every running dispatch whose child is `childID`, with the child's own
 * outcome: Claude Code reports a subagent's end, foreground or background, as
 * that subagent's `turn.complete`, carrying its answer.
 *
 * Returns whether anything changed.
 */
export const settleChild = (childID, state, result) => {
  if (!childID) return false;
  let changed = false;
  for (const board of boards.values()) {
    for (const record of board.records.values()) {
      if (record.childSessionID !== childID || record.state !== 'running') continue;
      record.state = state;
      record.endedAt = Date.now();
      if (result) record.result = truncate(unwrapSubagent(result));
      changed = true;
    }
  }
  return changed;
};

/**
 * A finished child that starts working again — resumed with a follow-up
 * message — is running again under the dispatch that first started it.
 */
export const reviveChild = (childID) => {
  if (!childID) return false;
  let changed = false;
  for (const board of boards.values()) {
    for (const record of board.records.values()) {
      if (record.childSessionID !== childID || record.state === 'running') continue;
      record.state = 'running';
      delete record.endedAt;
      record.result = null;
      changed = true;
    }
  }
  return changed;
};

/** The child ids of a session's dispatches that are still running. */
export const runningChildren = (sessionID) =>
  [...(boards.get(sessionID)?.records.values() ?? [])]
    .filter((r) => r.state === 'running' && r.childSessionID)
    .map((r) => r.childSessionID);
