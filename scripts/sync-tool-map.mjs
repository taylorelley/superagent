/**
 * Write the generated tool-map region into each document that carries one.
 *
 * With `--check`, report drift and exit non-zero instead of writing. That is
 * the mode the test suite uses.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { renderDocToolMap, docMarkers } from '../core/tool-map.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Documents that carry a generated region, and whose host's map each carries. */
export const TARGETS = [
  { file: '.opencode/INSTALL.md', host: 'opencode' },
  { file: 'docs/claude-code.md', host: 'claude' },
  { file: 'docs/codex.md', host: 'codex' },
];

const checkOnly = process.argv.includes('--check');

let drifted = 0;
let failures = 0;

for (const { file: relative, host } of TARGETS) {
  const filePath = path.join(repoRoot, relative);
  const original = fs.readFileSync(filePath, 'utf8');
  const { begin, end: endMarker } = docMarkers(host);
  const body = `${begin}\n\n${renderDocToolMap(host)}\n\n${endMarker}`;

  const start = original.indexOf(begin);
  const end = original.indexOf(endMarker);
  // `end <= start` means the markers are out of order, which would slice
  // garbage into the file rather than replacing the region.
  if (start === -1 || end === -1 || end <= start) {
    console.error(`${relative}: missing or misordered generated tool-map markers`);
    failures += 1;
    continue;
  }

  const updated = original.slice(0, start) + body + original.slice(end + endMarker.length);
  if (updated === original) continue;

  drifted += 1;
  if (checkOnly) {
    console.error(`${relative}: tool map is out of date; run scripts/sync-tool-map.sh`);
  } else {
    fs.writeFileSync(filePath, updated);
    console.log(`updated ${relative}`);
  }
}

// A marker problem is a failure in either mode: normal mode cannot fix it, and
// exiting 0 would report success while leaving the document untouched.
if (failures || (checkOnly && drifted)) process.exit(1);
if (!checkOnly && !drifted) console.log('tool map already up to date');
