/**
 * Register Superagent's skills through OpenCode V2's skill transform.
 *
 * V1 let a plugin push `skills/` onto `config.skills.paths` and leave the scan
 * to OpenCode. V2 has no global config object for a plugin to edit; a plugin
 * contributes skills to the registry directly. So the scan happens here, once
 * at setup — transforms are replayed and must not touch the filesystem — and
 * the transform only adds what was read.
 *
 * The result matches what OpenCode's own directory scan produces for the same
 * files: the ID is the skill's directory name, the content is the Markdown
 * body after the frontmatter, and the path is the absolute `SKILL.md` (which
 * is what gives the `skill` tool its base directory for supporting files).
 */

import fs from 'fs';
import path from 'path';
import { extractAndStripFrontmatter } from './fs-utils.js';
import { skillsDir as defaultSkillsDir } from './paths.js';
import { warn } from './log.js';

const truthy = (value) => ['true', 'yes', 'on', '1'].includes(String(value).trim().toLowerCase());

/** Read every `skills/<id>/SKILL.md` into a V2 `Skill.Info`. Never throws. */
export const discoverSkills = (dir = defaultSkillsDir) => {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    warn(`could not read skills directory ${dir}: ${err.message}`);
    return [];
  }

  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const file = path.join(dir, entry.name, 'SKILL.md');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, content } = extractAndStripFrontmatter(raw.replace(/\r\n/g, '\n'));
    skills.push({
      id: entry.name,
      name: frontmatter.name || entry.name,
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      ...(truthy(frontmatter['disable-model-invocation']) ? { autoinvoke: false } : {}),
      path: file,
      content,
    });
  }
  return skills.sort((a, b) => a.id.localeCompare(b.id));
};

/**
 * Add the skills to a skill editor, leaving any ID that already exists alone.
 *
 * A user who copied a Superagent skill into `.opencode/skills/` to tune it
 * meant their copy, the same way a colliding agent name means theirs.
 */
export const registerSkills = (editor, skills) => {
  const added = [];
  for (const skill of skills) {
    if (editor.get(skill.id) !== undefined) continue;
    editor.add(skill);
    added.push(skill.id);
  }
  return added;
};

/**
 * Call `onChange` (debounced) whenever a `SKILL.md` under `dir` changes.
 *
 * V2 runs the server as a long-lived background service, so a skill read once
 * at setup would go stale the moment someone edits a skill in a checkout or an
 * update lands. The caller re-reads and calls `ctx.skill.reload()`. Returns a
 * function that stops watching; a platform without recursive `fs.watch` gets
 * a no-op — the skills still load, they just refresh on the next restart.
 */
export const watchSkills = (dir, onChange, { delayMs = 200, watch = fs.watch } = {}) => {
  let timer = null;
  let watcher = null;
  try {
    watcher = watch(dir, { recursive: true, persistent: false }, (_event, file) => {
      if (file && !String(file).endsWith('SKILL.md') && String(file).includes('.')) return;
      clearTimeout(timer);
      timer = setTimeout(onChange, delayMs);
      timer.unref?.();
    });
    watcher.on?.('error', (err) => warn(`skills watcher stopped: ${err.message}`));
  } catch (err) {
    warn(`could not watch ${dir} for skill changes: ${err.message}`);
  }
  return () => {
    clearTimeout(timer);
    watcher?.close?.();
  };
};
