/**
 * Dispatch templates into OpenCode agent prompts. The extraction itself is
 * `core/prompt-compose.js`, shared with the Claude Code plugin; this module
 * adds the file read.
 */

import fs from 'fs';
import { extractDispatchTemplate } from '../../core/prompt-compose.js';

export * from '../../core/prompt-compose.js';

/** Read and extract in one step. */
export const extractDispatchTemplateFile = (filePath) =>
  extractDispatchTemplate(fs.readFileSync(filePath, 'utf8'), filePath);
