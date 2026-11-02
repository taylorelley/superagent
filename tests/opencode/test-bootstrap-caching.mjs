import fs from 'fs';
import { pathToFileURL } from 'url';
import { makeContext, userMessage } from './fake-v2-context.mjs';

const [, , pluginPath, scenario] = process.argv;

if (!pluginPath || !['present', 'missing'].includes(scenario)) {
  console.error('Usage: node test-bootstrap-caching.mjs PLUGIN_PATH present|missing');
  process.exit(2);
}

let existsCount = 0;
let readCount = 0;

const originalExistsSync = fs.existsSync;
const originalReadFileSync = fs.readFileSync;

fs.existsSync = function (...args) {
  if (isBootstrapSkillPath(args[0])) {
    existsCount += 1;
  }
  return originalExistsSync.apply(this, args);
};

fs.readFileSync = function (...args) {
  if (isBootstrapSkillPath(args[0])) {
    readCount += 1;
  }
  return originalReadFileSync.apply(this, args);
};

const mod = await import(pathToFileURL(pluginPath).href);
const fake = makeContext({ directory: '.' });
await mod.default.setup(fake.ctx);
// Setup reads every SKILL.md once to register the skills; what is measured
// here is the per-request path, so the counters start after it.
existsCount = 0;
readCount = 0;
const transform = (_input, output) =>
  fake.fire('session', 'context', {
    sessionID: 's',
    agent: 'build',
    system: [],
    messages: output.messages,
    options: {},
  });

const firstOutput = makeOutput(`${scenario} bootstrap first step`);
await transform({}, firstOutput);
const afterFirst = { existsCount, readCount };

const secondOutput = makeOutput(`${scenario} bootstrap second step`);
await transform({}, secondOutput);
const afterSecond = { existsCount, readCount };

const result = {
  scenario,
  firstBootstrapParts: countBootstrapParts(firstOutput),
  secondBootstrapParts: countBootstrapParts(secondOutput),
  staleMentionMapping: bootstrapText(firstOutput).includes('@mention'),
  staleTaskMapping: bootstrapText(firstOutput).includes('`Task` tool with subagents'),
  mapsSubagentToTool: bootstrapText(firstOutput).includes('`subagent` with `agent: "general"`'),
  mapsShellToShell: bootstrapText(firstOutput).includes('Run shell commands → `shell`'),
  teachesV1TaskTool: bootstrapText(firstOutput).includes('subagent_type'),
  firstReadCount: afterFirst.readCount,
  secondReadCount: afterSecond.readCount,
  firstExistsCount: afterFirst.existsCount,
  secondExistsCount: afterSecond.existsCount,
};

const failures =
  scenario === 'present' ? assertPresentBootstrap(result) : assertMissingBootstrap(result);

if (failures.length > 0) {
  console.error(JSON.stringify(result, null, 2));
  for (const failure of failures) {
    console.error(`FAIL: ${failure}`);
  }
  process.exit(1);
}

console.log(JSON.stringify(result, null, 2));

function isBootstrapSkillPath(filePath) {
  return String(filePath).replaceAll('\\', '/').includes('using-superagent/SKILL.md');
}

function makeOutput(text) {
  return { messages: [userMessage(text)] };
}

function countBootstrapParts(output) {
  return output.messages[0].content.filter(
    (part) => part.type === 'text' && part.text.includes('EXTREMELY_IMPORTANT'),
  ).length;
}

function bootstrapText(output) {
  return (
    output.messages[0].content.find(
      (part) => part.type === 'text' && part.text.includes('EXTREMELY_IMPORTANT'),
    )?.text || ''
  );
}

function assertPresentBootstrap(result) {
  const failures = [];
  if (result.firstBootstrapParts !== 1) {
    failures.push(
      `expected first transform to inject one bootstrap part, got ${result.firstBootstrapParts}`,
    );
  }
  if (result.secondBootstrapParts !== 1) {
    failures.push(
      `expected second transform to inject one bootstrap part, got ${result.secondBootstrapParts}`,
    );
  }
  if (result.firstReadCount !== 1) {
    failures.push(`expected first transform to read SKILL.md once, got ${result.firstReadCount}`);
  }
  if (result.secondReadCount !== result.firstReadCount) {
    failures.push(
      `expected cached second transform to do no additional reads, got ${result.secondReadCount - result.firstReadCount}`,
    );
  }
  if (result.secondExistsCount !== result.firstExistsCount) {
    failures.push(
      `expected cached second transform to do no additional exists checks, got ${result.secondExistsCount - result.firstExistsCount}`,
    );
  }
  if (result.staleMentionMapping) {
    failures.push('expected OpenCode bootstrap not to teach @mention subagent syntax');
  }
  if (result.staleTaskMapping) {
    failures.push('expected OpenCode bootstrap not to teach stale Task-tool mapping');
  }
  if (!result.mapsSubagentToTool) {
    failures.push('expected OpenCode bootstrap to map general-purpose subagents to subagent');
  }
  if (!result.mapsShellToShell) {
    failures.push('expected OpenCode bootstrap to map shell commands to the V2 shell tool');
  }
  if (result.teachesV1TaskTool) {
    failures.push('expected OpenCode bootstrap not to teach the V1 task tool (subagent_type)');
  }
  return failures;
}

function assertMissingBootstrap(result) {
  const failures = [];
  if (result.firstBootstrapParts !== 0) {
    failures.push(
      `expected no bootstrap when SKILL.md is missing, got ${result.firstBootstrapParts}`,
    );
  }
  if (result.secondBootstrapParts !== 0) {
    failures.push(
      `expected no bootstrap on second missing-file transform, got ${result.secondBootstrapParts}`,
    );
  }
  if (result.firstReadCount !== 0 || result.secondReadCount !== 0) {
    failures.push(`expected missing file path to avoid reads, got ${result.secondReadCount}`);
  }
  if (result.firstExistsCount < 1) {
    failures.push('expected first transform to check whether SKILL.md exists');
  }
  if (result.secondExistsCount !== result.firstExistsCount) {
    failures.push(
      `expected missing-file result to be cached, got ${result.secondExistsCount - result.firstExistsCount} extra exists checks`,
    );
  }
  return failures;
}
