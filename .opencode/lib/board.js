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
 * OpenCode does not work that way. `BackgroundJob.notify()` injects a finished
 * task's result back into the parent session, and the task tool's own output
 * tells the model in as many words: "You will be notified automatically when it
 * finishes. DO NOT sleep, poll for progress, ask the task for status."
 * (See docs/superagent.md for the source references.)
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

export const BOARD_MARKER = '<SUPERAGENT_JOB_BOARD>';

/** sessionID → { records: Map<callID, record> } */
const boards = new Map();

export const resetBoards = () => boards.clear();

const boardFor = (sessionID) => {
  if (!boards.has(sessionID)) boards.set(sessionID, { records: new Map() });
  return boards.get(sessionID);
};

const truncate = (text, max = 600) => {
  const clean = String(text ?? '').trim().replace(/\s+/g, ' ');
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
};

/**
 * Record a dispatch and check it against what is already running.
 *
 * Called from `tool.execute.before`, so it can annotate the outgoing prompt.
 * Mutates `args.prompt` when there is a conflict and enforcement is on.
 */
export const onDispatch = (sessionID, callID, args, settings) => {
  if (!settings?.board?.enabled || !sessionID || !callID) return;

  const board = boardFor(sessionID);
  const ownership = parseOwnership(args?.prompt);

  const record = {
    id: callID,
    agent: args?.subagent_type ?? 'unknown',
    objective: truncate(args?.description, 80),
    state: 'running',
    background: args?.background === true,
    ownership,
    startedAt: Date.now(),
    result: null,
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

/**
 * Record a dispatch's outcome.
 *
 * Called from `tool.execute.after`. A background dispatch has not finished —
 * the tool returns as soon as the job is launched — so it stays `running` and
 * we keep the child session id from `metadata.jobId` to match up the
 * completion event later.
 */
export const onDispatchResult = (sessionID, callID, output, settings) => {
  if (!settings?.board?.enabled) return;

  const record = boards.get(sessionID)?.records.get(callID);
  if (!record) return;

  if (output?.metadata?.background) {
    record.childSessionID = output.metadata.jobId;
    return;
  }

  record.state = 'completed';
  record.endedAt = Date.now();
  record.result = truncate(output?.output);
};

/** Mark a background dispatch finished, from a session lifecycle event. */
export const onSessionEvent = (type, sessionID) => {
  if (!sessionID) return;
  const terminal = { 'session.idle': 'completed', 'session.error': 'error', 'session.deleted': 'cancelled' };
  const state = terminal[type];
  if (!state) return;

  for (const board of boards.values()) {
    for (const record of board.records.values()) {
      if (record.childSessionID === sessionID && record.state === 'running') {
        record.state = state;
        record.endedAt = Date.now();
      }
    }
  }

  // `boards` lives as long as the process, so a deleted session's ledger would
  // otherwise be retained — and scanned — forever. Done after the transitions
  // above so a deleted child still settles its parent's record.
  if (type === 'session.deleted') boards.delete(sessionID);
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
    ...records.map((r) =>
      `| ${r.agent} | ${r.objective || '—'} | ${r.state}${r.background ? ' (bg)' : ''} | ${
        r.ownership?.write?.length ? r.ownership.write.join(', ') : '—'
      } |`
    ),
  ];

  const unowned = running.filter((r) => !r.ownership);
  if (unowned.length) {
    lines.push(
      '',
      `${unowned.length} running dispatch(es) declared no file ownership. If any of`,
      'them writes, you cannot detect a collision — declare ownership when you',
      'dispatch write-capable work.'
    );
  }

  lines.push('</SUPERAGENT_JOB_BOARD>');
  return lines.join('\n');
};

/**
 * Attach the board snapshot to the last user message.
 *
 * `messages.transform` receives no session id, so identity comes from the
 * messages themselves. Under the `latest` strategy any previous snapshot is
 * stripped first: the board is a live view, and leaving stale copies in history
 * both wastes context and invites the model to act on an old state.
 */
export const injectBoard = (messages, settings) => {
  if (!settings?.board?.enabled || !Array.isArray(messages) || !messages.length) return false;

  const sessionID = messages.find((m) => m?.info?.sessionID)?.info?.sessionID;
  if (!sessionID) return false;

  const snapshot = renderBoard(sessionID);

  if (settings.board.strategy === 'latest') {
    for (const message of messages) {
      if (!Array.isArray(message.parts)) continue;
      message.parts = message.parts.filter(
        (part) => !(part.type === 'text' && typeof part.text === 'string' && part.text.startsWith(BOARD_MARKER))
      );
    }
  }

  if (!snapshot) return false;

  const target = [...messages].reverse().find((m) => m?.info?.role === 'user' && m.parts?.length);
  if (!target) return false;

  if (
    settings.board.strategy !== 'latest' &&
    target.parts.some((p) => p.type === 'text' && p.text === snapshot)
  ) {
    return false;
  }

  target.parts.push({ ...target.parts[0], type: 'text', text: snapshot });
  return true;
};
