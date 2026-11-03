/**
 * The council's OpenCode registration. Member validation, the councillor
 * prompt and the `/council` instruction are host-neutral and live in
 * `core/council.js`, shared with the Claude Code plugin.
 */

import { defineAgent, parseModelRef } from './agents.js';
import { toRules } from './permissions.js';
import { usableMembers, councillorPrompt, COUNCILLOR_PERMISSION } from '../../core/council.js';

export * from '../../core/council.js';

/**
 * Register one subagent per councillor onto an agent editor.
 *
 * Returns `{ registered, conflicts }`. Runs inside a replayable transform, so
 * like `registerAgents` it reports instead of logging; `usableMembers` warns,
 * so callers validate once at setup and pass the result in.
 */
export const registerCouncillors = (
  editor,
  settings,
  members = usableMembers(settings?.council),
) => {
  const result = { registered: [], conflicts: [] };
  if (!editor || !members.length) return result;

  const prefix = settings.agents?.prefix ?? '';

  for (const member of members) {
    const name = `${prefix}councillor-${member.name}`;
    if (editor.get(name) !== undefined) {
      result.conflicts.push({ kind: 'agent', name });
      continue;
    }

    defineAgent(editor, name, {
      description: `Council member ${member.name}. Answers one question independently.`,
      mode: 'subagent',
      system: councillorPrompt(member),
      permissions: toRules(COUNCILLOR_PERMISSION),
      model: parseModelRef(member.model),
    });
    result.registered.push({ name, member });
  }

  return result;
};
