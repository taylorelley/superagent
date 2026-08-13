/**
 * The council: one question, several models, one synthesized answer.
 *
 * A plugin tool cannot call `task()` — there is no API for invoking a tool from
 * inside another tool's execute. So the fan-out is done the way OpenCode
 * actually supports it: each councillor is a registered subagent with its own
 * model, and a council agent dispatches them in parallel and synthesizes.
 *
 * That keeps the whole feature on documented surface and adds no dependency.
 * The alternative — driving `client.session.create` / `client.session.prompt`
 * from a plugin-registered tool — would need `@opencode-ai/plugin` at runtime
 * for its zod-based tool schema, which this plugin deliberately does not have.
 *
 * Councillors are sealed: no edits, no dispatching, no shell. They are there to
 * reason about a question, and a councillor that goes off investigating turns a
 * cheap parallel opinion into an expensive serial one.
 */

import { warn } from './log.js';

/** Councillors get read access, but no way to change or launch anything. */
const COUNCILLOR_PERMISSION = { edit: 'deny', task: 'deny', bash: 'deny' };

/** A council needs disagreement to be worth anything. */
export const MIN_MEMBERS = 2;

/**
 * Validate the configured members.
 *
 * Returns the usable ones. Members without a distinct model are kept but
 * reported: running three councillors on one model produces three copies of the
 * same opinion and calls it consensus, which is worse than not asking.
 */
export const usableMembers = (council) => {
  const members = (council?.members ?? []).filter((m) => m && typeof m.name === 'string' && m.name);
  if (!council?.enabled) return [];
  if (members.length < MIN_MEMBERS) {
    if (members.length) {
      warn(`council needs at least ${MIN_MEMBERS} members to be meaningful; got ${members.length}`);
    }
    return [];
  }

  const models = members.map((m) => m.model).filter(Boolean);
  if (new Set(models).size < 2) {
    warn(
      'council members do not have distinct models. Councillors on the same model ' +
        'produce the same answer, so the result will be agreement by construction, not consensus.'
    );
  }
  return members;
};

/** Register one subagent per councillor. Returns the registered names. */
export const registerCouncillors = (config, settings) => {
  const members = usableMembers(settings?.council);
  if (!members.length) return [];

  config.agent = config.agent || {};
  const prefix = settings.agents?.prefix ?? '';
  const registered = [];

  for (const member of members) {
    const name = `${prefix}councillor-${member.name}`;
    if (Object.prototype.hasOwnProperty.call(config.agent, name)) {
      warn(`an agent named "${name}" already exists; leaving it alone`);
      continue;
    }

    config.agent[name] = {
      description: `Council member ${member.name}. Answers one question independently.`,
      mode: 'subagent',
      prompt: councillorPrompt(member),
      permission: COUNCILLOR_PERMISSION,
      ...(member.model ? { model: member.model } : {}),
    };
    registered.push({ name, member });
  }

  return registered;
};

const councillorPrompt = (member) =>
  [
    `You are council member "${member.name}".`,
    '',
    'You have been asked one question, in parallel with other members who are',
    'running different models. You are not collaborating with them and you will',
    'not see their answers. Answer independently — the point of a council is that',
    'the members can disagree.',
    '',
    ...(member.steering ? [`Your assigned emphasis: ${member.steering}`, ''] : []),
    'You may read files to ground your answer. You cannot edit anything, run',
    'commands, or dispatch subagents.',
    '',
    'End your response with exactly this block, and nothing after it:',
    '',
    'VERDICT: <your recommendation in one sentence>',
    'CONFIDENCE: <high|medium|low>',
    'RISK: <the strongest argument against your own verdict>',
    '',
    'The RISK line is not optional and must not be empty. A council member who',
    'cannot argue against their own position has not thought about the question.',
  ].join('\n');

/**
 * The instruction `/council` expands into.
 *
 * Written for the model that receives it, listing the exact agents registered
 * in this session so it cannot dispatch to one that does not exist.
 */
export const councilInstruction = (councillors, question) => {
  if (!councillors.length) {
    return [
      'The council is not configured for this session.',
      '',
      'It needs at least two members with distinct models in `superagent.json`:',
      '',
      '```json',
      '{',
      '  "council": {',
      '    "enabled": true,',
      '    "members": [',
      '      { "name": "alpha", "model": "provider/model-a", "steering": "correctness and edge cases" },',
      '      { "name": "beta",  "model": "provider/model-b", "steering": "simplicity and maintainability" }',
      '    ]',
      '  }',
      '}',
      '```',
      '',
      'Tell your human partner this, and answer their question directly instead.',
    ].join('\n');
  }

  return [
    '<SUPERAGENT_COUNCIL>',
    'Convene the council on this question:',
    '',
    question || '(the question is the user\'s previous message)',
    '',
    `Dispatch all ${councillors.length} councillors in a SINGLE message, as parallel`,
    '`task` calls, each with the identical question:',
    '',
    ...councillors.map((c) => `  - subagent_type: \`${c.name}\``),
    '',
    'Give each one the full question and whatever context it needs to answer',
    'without access to your conversation. Do not tell any councillor what the',
    'others think.',
    '',
    'When they have all answered, report:',
    '',
    '1. **Verdict** — your synthesis, in a sentence.',
    '2. **Agreement** — `unanimous` if every VERDICT says the same thing,',
    '   `majority` if most do, `split` if they genuinely disagree. Judge the',
    '   substance, not the wording.',
    '3. **The table** — one row per councillor: name, verdict, confidence.',
    '4. **Dissent** — every RISK line that no other member addressed. This is the',
    '   most valuable output; do not summarize it away.',
    '5. **Participation** — name any councillor that failed to answer.',
    '',
    'If fewer than two councillors answered, say the council was inconclusive and',
    'why. Do not present one opinion as a consensus.',
    '</SUPERAGENT_COUNCIL>',
  ].join('\n');
};
