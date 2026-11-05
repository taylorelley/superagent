import { spawn } from 'node:child_process';
import { prepareLaunch, launchDirectory } from './lib/launch.js';

try {
  const args = process.argv.slice(2);
  const launch = prepareLaunch({ projectDir: launchDirectory(args) });
  for (const warning of launch.warnings) console.error(`Superagent: ${warning}`);
  const child = spawn('codex', [...launch.args, ...args], {
    env: launch.env,
    stdio: 'inherit',
  });
  child.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0);
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
