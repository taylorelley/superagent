import { readState, statePath, sessionScope } from './lib/state.js';
import { configDirectory, loadConfig } from './lib/config.js';
import { createAdapter } from './lib/adapter.js';
import { renderTextPanel } from './lib/panel.js';
import { readCache, cachePath } from '../.opencode/lib/update-check.js';
const args = process.argv.slice(2);
const index = args.indexOf('--session');
const sessionID = index < 0 ? process.env.CODEX_THREAD_ID : args[index + 1];
try {
  if (!sessionID) throw new Error('Specify --session <thread id> or CODEX_THREAD_ID');
  const configDir = configDirectory();
  const scope = await sessionScope(configDir, sessionID);
  const draw = async () => {
    const state = await readState(statePath(configDir, scope));
    const settings = loadConfig({
      configDir,
      projectDir: state.sessions[scope]?.projectDir,
      sessionPreset: state.sessions[scope]?.preset,
    });
    if (!settings.tui.enabled) {
      process.stdout.write('Superagent panel is disabled.\n');
      return false;
    }
    const panel = renderTextPanel({
      state,
      sessionID: scope,
      settings,
      adapter: createAdapter(settings, {
        configDir,
        roleDir: state.sessions[scope]?.roleDir ?? process.env.SUPERAGENT_ROLE_DIR,
        requireInstalled: true,
      }),
      expanded: args.includes('--expanded'),
      update: readCache(cachePath(configDir)),
    });
    if (args.includes('--watch') && process.stdout.isTTY) process.stdout.write('\x1b[H\x1b[2J');
    process.stdout.write(panel + '\n');
    return true;
  };
  const active = await draw();
  if (active && args.includes('--watch')) {
    const timer = setInterval(() => {
      draw()
        .then((enabled) => {
          if (!enabled) clearInterval(timer);
        })
        .catch((error) => {
          console.error(error.message);
          clearInterval(timer);
          process.exitCode = 1;
        });
    }, 1000);
    const stop = () => clearInterval(timer);
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
