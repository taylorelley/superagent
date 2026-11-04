/**
 * The session bootstrap, as text: the `using-superagent` skill, the host's
 * tool map, and whatever the host appends (the routing table, in practice).
 *
 * Shared by both hosts. Reading the skill file is the host's job — OpenCode's
 * server uses Node's `fs`, Claude Code's hooks module uses `$.fs` — so this
 * module takes the file's text and returns the block to inject.
 *
 * It is injected as *user* content rather than system prompt, deliberately:
 * system messages are repeated every turn (token bloat, #750) and multiple
 * system messages break Qwen and other models (#894).
 */

import { extractAndStripFrontmatter } from './parse.js';
import { renderBootstrapToolMap } from './tool-map.js';

/** The marker used to detect an already-injected bootstrap. */
export const BOOTSTRAP_MARKER = 'EXTREMELY_IMPORTANT';

/**
 * Build the bootstrap block from the text of `using-superagent/SKILL.md`.
 *
 * Returns null when there is no skill text to build it from. `host` picks the
 * tool map (`opencode` or `claude`); `extra` is appended inside the block.
 */
export const renderBootstrap = (skillText, { host = 'opencode', extra = '' } = {}) => {
  if (typeof skillText !== 'string') return null;
  const { content } = extractAndStripFrontmatter(skillText);
  return [
    '<EXTREMELY_IMPORTANT>',
    'You have superagent.',
    '',
    '**IMPORTANT: The using-superagent skill content is included below. It is ALREADY LOADED - you are currently following it. Do NOT use the skill tool to load "using-superagent" again - that would be redundant.**',
    '',
    content,
    '',
    renderBootstrapToolMap(host),
    ...(extra ? ['', extra] : []),
    '</EXTREMELY_IMPORTANT>',
  ].join('\n');
};

/** The text of a V2 message part, or '' for a non-text part. */
const partText = (part) =>
  part?.type === 'text' && typeof part.text === 'string' ? part.text : '';

/**
 * Replace a message's content.
 *
 * The messages a `context` hook receives are owned by the hook for this one
 * request, but their content arrays come from schema decoding and may be
 * frozen. Assign when that works; otherwise put a copy, with the same
 * prototype, in the message's place.
 */
export const withContent = (messages, index, content) => {
  const message = messages[index];
  try {
    message.content = content;
    if (message.content === content) return;
  } catch {
    // Frozen or a getter-only field — fall through to the copy.
  }
  messages[index] = Object.assign(Object.create(Object.getPrototypeOf(message)), message, {
    content,
  });
};

/**
 * Prepend the bootstrap to the first user message, once.
 *
 * `messages` is the V2 model-request transcript (`{ role, content: [...] }`).
 * Changes made here affect only the outgoing request, never the persisted
 * history — which is what the V1 messages transform did too. The guard is a
 * content check rather than a flag because another plugin may already have
 * injected it.
 */
export const injectBootstrap = (messages, bootstrap) => {
  if (!bootstrap || !Array.isArray(messages) || !messages.length) return false;

  const index = messages.findIndex((m) => m?.role === 'user');
  if (index === -1) return false;
  const content = Array.isArray(messages[index].content) ? messages[index].content : [];
  if (!content.length) return false;

  if (content.some((part) => partText(part).includes(BOOTSTRAP_MARKER))) return false;

  // Some providers join a message's text parts with no separator, so the
  // bootstrap brings its own blank line rather than run into the user's text.
  withContent(messages, index, [{ type: 'text', text: `${bootstrap}\n\n` }, ...content]);
  return true;
};
