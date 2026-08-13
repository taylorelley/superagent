/**
 * Verify the plugin actually imports and returns the hooks OpenCode expects.
 *
 * `node --check` only parses a file; it does not resolve imports. Since the
 * plugin was split across `.opencode/lib/`, a wrong relative path or a missing
 * file passes the syntax check and fails only at load time — inside OpenCode,
 * where a plugin that fails to import is silently inert. This test is the
 * regression net for that.
 */

import { pathToFileURL } from 'url';

const [, , pluginPath] = process.argv;

if (!pluginPath) {
  console.error('Usage: node test-plugin-exports.mjs PLUGIN_PATH');
  process.exit(2);
}

const REQUIRED_HOOKS = ['config', 'experimental.chat.messages.transform'];

const mod = await import(pathToFileURL(pluginPath).href);

if (typeof mod.SuperagentPlugin !== 'function') {
  console.error('FAIL: module does not export a SuperagentPlugin function');
  process.exit(1);
}

const plugin = await mod.SuperagentPlugin({ client: {}, directory: '.' });

const missing = REQUIRED_HOOKS.filter((hook) => typeof plugin[hook] !== 'function');
if (missing.length > 0) {
  console.error(`FAIL: plugin is missing hook(s): ${missing.join(', ')}`);
  process.exit(1);
}

// The config hook must register the skills directory on a bare config object,
// and must be idempotent — OpenCode may call it more than once.
const config = {};
await plugin.config(config);
await plugin.config(config);

const paths = config?.skills?.paths;
if (!Array.isArray(paths) || paths.length !== 1) {
  console.error(`FAIL: expected exactly one registered skills path, got ${JSON.stringify(paths)}`);
  process.exit(1);
}
if (!paths[0].endsWith('skills')) {
  console.error(`FAIL: registered skills path looks wrong: ${paths[0]}`);
  process.exit(1);
}

// A hook must never throw out into the host, even on malformed input.
await plugin.config(null);
await plugin['experimental.chat.messages.transform']({}, {});

console.log('ok: plugin loads, exports hooks, registers skills idempotently');
