/**
 * Verify the plugin actually imports and registers what OpenCode V2 expects.
 *
 * `node --check` only parses a file; it does not resolve imports. Since the
 * plugin was split across `.opencode/lib/`, a wrong relative path or a missing
 * file passes the syntax check and fails only at load time — inside OpenCode,
 * where a plugin that fails to import is silently inert. This test is the
 * regression net for that.
 */

import { pathToFileURL } from 'url';
import { makeContext, userMessage, messageText } from './fake-v2-context.mjs';

const [, , pluginPath] = process.argv;

if (!pluginPath) {
  console.error('Usage: node test-plugin-exports.mjs PLUGIN_PATH');
  process.exit(2);
}

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

const mod = await import(pathToFileURL(pluginPath).href);
const plugin = mod.default;

// The V2 shape: a default-exported `{ id, setup }` (what `Plugin.define` returns).
if (!plugin || typeof plugin.id !== 'string' || !plugin.id) fail('default export has no id');
if (typeof plugin.setup !== 'function') fail('default export has no setup function');

const fake = makeContext({ directory: '.' });
const cleanup = await plugin.setup(fake.ctx);
if (typeof cleanup !== 'function') fail('setup did not return a cleanup function');

// Skills are registered through the skill transform, and replaying it is stable.
const skills = fake.skills();
if (!skills.get('using-superagent')) fail('using-superagent was not registered as a skill');
if (!skills.get('brainstorming')?.path?.endsWith('brainstorming/SKILL.md')) {
  fail(`brainstorming skill path looks wrong: ${skills.get('brainstorming')?.path}`);
}
if (fake.skills().list().length !== skills.list().length) fail('skill transform is not idempotent');

// The hooks the plugin depends on are registered on their V2 domains.
for (const [domain, name] of [
  ['session', 'context'],
  ['tool', 'execute.before'],
  ['tool', 'execute.after'],
]) {
  if (!fake.hooks[domain][name]?.length) fail(`no ${domain} "${name}" hook registered`);
}

// The context hook injects the bootstrap into the first user message.
const event = {
  sessionID: 's',
  agent: 'build',
  system: [],
  messages: [userMessage('hi')],
  options: {},
};
await fake.fire('session', 'context', event);
if (!messageText(event.messages[0]).includes('EXTREMELY_IMPORTANT')) {
  fail('context hook did not inject the bootstrap');
}

// A hook must never throw out into the host, even on malformed input.
await fake.fire('session', 'context', {});
await fake.fire('tool', 'execute.before', {});
await fake.fire('tool', 'execute.after', { tool: 'subagent' });

await cleanup();
console.log('ok: plugin loads, registers skills idempotently, wires its V2 hooks');
