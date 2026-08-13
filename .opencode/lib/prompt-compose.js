/**
 * Turn Superagent' subagent dispatch templates into OpenCode agent prompts.
 *
 * Files like `skills/subagent-driven-development/implementer-prompt.md` are not
 * system prompts. They are templates a controller fills in and passes to a
 * dispatch tool:
 *
 *     # Implementer Subagent Prompt Template
 *     Use this template when dispatching an implementer subagent.
 *     ```
 *     Subagent (general-purpose):
 *       description: "Implement Task N: [task name]"
 *       model: [MODEL — REQUIRED: ...]
 *       prompt: |
 *         You are implementing Task N: [task name]
 *         ...
 *     ```
 *
 * Registering one as an agent means splitting it in two. The invariant half —
 * role, rules, report format — becomes the agent's system prompt. The
 * `[PLACEHOLDER]` half is per-dispatch context the orchestrator supplies in the
 * task prompt, so it stays a placeholder and the agent is told to say so when
 * one it needs is missing.
 *
 * The `model:` line is dropped outright: OpenCode's `task` tool has no model
 * parameter, so per-dispatch model choice is not a thing an agent can act on.
 * Model routing happens through which agent is dispatched.
 */

import fs from 'fs';

/** Marks the start of the dispatch block inside these templates. */
const DISPATCH_HEADER = /^Subagent \(/;

/** Header keys inside the block that describe the dispatch, not the role. */
const DISPATCH_KEYS = /^\s*(description|model|prompt|subagent_type):/;

/** Remove the common leading indent so the body reads as a top-level prompt. */
const dedent = (lines) => {
  const indents = lines
    .filter((line) => line.trim())
    .map((line) => line.match(/^\s*/)[0].length);
  if (!indents.length) return lines;
  const common = Math.min(...indents);
  return lines.map((line) => line.slice(common));
};

/**
 * Pull the agent-facing prompt body out of a dispatch template.
 *
 * Throws on a shape it does not recognise. That is intentional: these templates
 * are maintained upstream, and a silent fallback would register an agent whose
 * prompt is a page of markdown *about* dispatching rather than instructions to
 * follow. `tests/opencode/test-prompt-compose.mjs` runs this against every real
 * template so an upstream edit fails a test instead of degrading a session.
 */
export const extractDispatchTemplate = (text, label = 'template') => {
  const lines = text.split('\n');

  const fenceStart = lines.findIndex(
    (line, i) => /^```/.test(line) && DISPATCH_HEADER.test(lines[i + 1] ?? '')
  );
  if (fenceStart === -1) {
    throw new Error(`${label}: no fenced block starting with "Subagent (" found`);
  }

  const fenceEnd = lines.findIndex((line, i) => i > fenceStart && /^```/.test(line));
  const body = lines.slice(fenceStart + 1, fenceEnd === -1 ? lines.length : fenceEnd);

  // Drop the dispatch header lines. `model:` in these templates spans two
  // lines, so continuation lines (deeper indented, no key) go with it.
  //
  // `prompt:` is the exception, and explicitly so. Its "continuation" is the
  // entire agent-facing body — the thing we are here to extract. It survives
  // today only because these templates indent it four spaces while `model:`
  // wraps at nine, which is a coincidence of formatting rather than a design.
  // Naming the exception means a template that indents its prompt body more
  // deeply still extracts correctly.
  const kept = [];
  let skippingKey = false;
  for (const line of body) {
    if (DISPATCH_HEADER.test(line)) {
      skippingKey = false;
      continue;
    }
    const key = line.match(DISPATCH_KEYS);
    if (key) {
      skippingKey = key[1] !== 'prompt';
      continue;
    }
    // A continuation of a skipped key: indented past the key depth without
    // introducing content at the prompt body's level.
    if (skippingKey && /^\s{6,}\S/.test(line) && !line.trim().startsWith('#')) {
      continue;
    }
    skippingKey = false;
    kept.push(line);
  }

  const result = dedent(kept).join('\n').trim();
  if (!result) throw new Error(`${label}: extracted prompt is empty`);
  return result;
};

/** Read and extract in one step. */
export const extractDispatchTemplateFile = (filePath) =>
  extractDispatchTemplate(fs.readFileSync(filePath, 'utf8'), filePath);

/**
 * The preamble every extracted prompt carries.
 *
 * It does two jobs. It converts the leftover `[PLACEHOLDER]` slots from a
 * substitution mechanism into a runtime contract — an agent that is missing
 * context it needs says so instead of inventing a path. And it tells the agent
 * to ignore the session bootstrap, which `using-superagent` itself asks
 * subagents to do via its `<SUBAGENT-STOP>` block.
 */
export const AGENT_CONTRACT = `<SUPERAGENT_CONTRACT>
You are a Superagent specialist. You were dispatched to do one scoped job and
report back. The session bootstrap you may see contains a \`<SUBAGENT-STOP>\`
block addressed to you: honor it, and do not run the skill-selection workflow
meant for the orchestrator.

The instructions below are a template. Bracketed placeholders like
\`[BRIEF_FILE]\` are filled by the task prompt your dispatcher sent you, not by
this prompt. If a placeholder your work depends on is missing from that task
prompt, reply immediately with \`NEEDS_CONTEXT: <what is missing>\` and stop.
Never invent a file path, a requirement, or a git range.
</SUPERAGENT_CONTRACT>`;

/** Compose the final agent prompt: contract, then the extracted role body. */
export const composeAgentPrompt = (body, extra = '') =>
  [AGENT_CONTRACT, '', body, ...(extra ? ['', extra] : [])].join('\n');
