import { readHookInput } from '../lib/input.js';
import { configDirectory, loadConfig } from '../lib/config.js';
import { version } from '../lib/adapter.js';
import { checkForUpdate, cachePath } from '../../.opencode/lib/update-check.js';
try {
  const input = await readHookInput(process.stdin);
  const configDir = configDirectory();
  const settings = loadConfig({ configDir, projectDir: input.cwd });
  if (settings.updateCheck.enabled)
    await checkForUpdate({
      currentVersion: version,
      cacheFile: cachePath(configDir),
      intervalHours: settings.updateCheck.intervalHours,
    });
} catch (error) {
  console.error(`Superagent update check: ${error.message}`);
}
process.stdout.write('{}\n');
