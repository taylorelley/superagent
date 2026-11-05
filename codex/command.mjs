import { configDirectory, loadConfig } from './lib/config.js';
import { createAdapter } from './lib/adapter.js';
import { statePath, withState, sessionScope, readState } from './lib/state.js';
import { restoreBoardState } from '../core/board.js';
import { expandCommand } from './lib/commands.js';

const args = process.argv.slice(2);
const name = args.shift();
const index = args.indexOf('--session');
const sessionID = index < 0 ? process.env.CODEX_THREAD_ID : args.splice(index, 2)[1];
try {
  if (!sessionID) throw new Error('Specify --session <Codex thread id> or CODEX_THREAD_ID');
  const configDir = configDirectory();
  const scope = await sessionScope(configDir, sessionID);
  const execute = async (state) => {
    restoreBoardState(state.boards);
    const settings = loadConfig({
      configDir,
      projectDir: state.sessions[scope]?.projectDir,
      sessionPreset: state.sessions[scope]?.preset,
    });
    const adapter = createAdapter(settings, {
      configDir,
      roleDir: state.sessions[scope]?.roleDir ?? process.env.SUPERAGENT_ROLE_DIR,
      requireInstalled: true,
    });
    return expandCommand(name, args.join(' '), {
      settings,
      adapter,
      state,
      sessionID: scope,
      configDir,
      projectDir: state.sessions[scope]?.projectDir,
    });
  };
  const file = statePath(configDir, scope);
  // Only preset selection mutates controller state. Network updates must not
  // hold its lock while other agents are reporting progress.
  const text =
    name === 'preset' ? await withState(file, execute) : await execute(await readState(file));
  if (text === null) throw new Error('Unknown Superagent command');
  process.stdout.write(text + '\n');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
