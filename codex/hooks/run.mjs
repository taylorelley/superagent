import { configDirectory, loadConfig } from '../lib/config.js';
import { createAdapter, observePlan } from '../lib/adapter.js';
import { statePath, withState, sessionScope, linkSession } from '../lib/state.js';
import { handleEvent } from '../lib/events.js';
import { readHookInput } from '../lib/input.js';

try {
  const input = await readHookInput(process.stdin);
  if (typeof input.session_id !== 'string' || typeof input.cwd !== 'string')
    throw new Error('Invalid hook identity');
  const configDir = configDirectory();
  if (process.env.SUPERAGENT_DISABLE === '1' || process.env.SUPERAGENT_DISABLE === 'true') {
    process.stdout.write('{}\n');
  } else {
    const scope = await sessionScope(configDir, input.session_id);
    const output = await withState(statePath(configDir, scope), (state) => {
      const controller = (state.sessions[scope] ??= {});
      controller.projectDir ??= input.cwd;
      controller.roleDir ??= process.env.SUPERAGENT_ROLE_DIR;
      const settings = loadConfig({
        configDir,
        projectDir: controller.projectDir,
        sessionPreset: controller.preset,
      });
      const output = handleEvent(
        input,
        state,
        settings,
        createAdapter(settings, {
          configDir,
          roleDir: process.env.SUPERAGENT_ROLE_DIR,
          requireInstalled: true,
        }),
      );
      if (input.hook_event_name === 'PostToolUse') {
        const plan = observePlan(input);
        if (plan) controller.plan = plan;
      }
      return output;
    });
    if (input.hook_event_name === 'SubagentStart' && typeof input.agent_id === 'string') {
      await linkSession(configDir, input.agent_id, scope);
    }
    process.stdout.write(`${JSON.stringify(output)}\n`);
  }
} catch (error) {
  console.error(`Superagent hook: ${error.message}`);
  // A broken guard must never permit the guarded tool to run.
  process.stderr.write('Superagent could not enforce its role policy.\n');
  process.exitCode = 2;
}
