/**
 * skills.js — Claude-style skill discovery and loading.
 *
 * A skill is a folder inside the skills directory containing a SKILL.md with
 * YAML frontmatter (name, description) followed by markdown instructions —
 * the same format Claude Code uses, so existing skills work unmodified.
 * This module scans that directory, parses frontmatter (a deliberately tiny
 * parser: key/value pairs with folded multiline values), and returns skill
 * bodies for injection into the system prompt.
 */
const fs = require('fs');
const path = require('path');
const { SKILLS_DIR, IMPORT_MAX_FILES, IMPORT_MAX_BYTES } = require('./config');

fs.mkdirSync(SKILLS_DIR, { recursive: true });

function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  let curKey = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (kv) { curKey = kv[1]; meta[curKey] = kv[2].trim(); }
    else if (curKey && /^\s+\S/.test(line)) meta[curKey] += ' ' + line.trim(); // folded multiline
  }
  return { meta, body: m[2] };
}

function scanSkills() {
  const skills = [];
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      skills.push({
        id: entry.name,
        name: meta.name || entry.name,
        description: meta.description || '',
        size: body.length,
      });
    } catch { /* skip unreadable skill */ }
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function skillBody(sid) {
  if (/[\\/]|\.\./.test(sid)) throw new Error('bad skill id');
  const raw = fs.readFileSync(path.join(SKILLS_DIR, sid, 'SKILL.md'), 'utf8');
  const { meta, body } = parseFrontmatter(raw);
  return { meta, body };
}

/* ---- creation ---- */

const TEMPLATE_PATH = path.join(__dirname, 'skill-template.md');

/** "My Cool Skill!" -> "my-cool-skill" (folder name = skill id). */
function slugify(name) {
  return String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Scaffold a new skill folder and return its catalog entry. The SKILL.md
 * body comes from lib/skill-template.md, or from `body` when provided
 * (e.g. instructions written by a local model). Throws with a human-readable
 * message on invalid names or collisions; never writes outside SKILLS_DIR
 * (the id is a strict slug).
 */
function createSkill(name, description, body) {
  const id = slugify(name);
  if (!id) throw new Error('skill name must contain letters or numbers');
  const dir = path.join(SKILLS_DIR, id);
  if (fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`skill "${id}" already exists`);

  const desc = String(description || '').trim().replace(/\r?\n/g, ' ')
    || 'One line describing when to use this skill.';
  const content = body
    ? `---\nname: ${id}\ndescription: ${desc}\n---\n\n${body.trim()}\n`
    : fs.readFileSync(TEMPLATE_PATH, 'utf8')
        .replace('{{name}}', id)
        .replace('{{description}}', desc);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  return { id, name: id, description: desc, path: path.join(dir, 'SKILL.md') };
}

/**
 * Have a local model write the skill's instructions and scaffold the folder
 * with them. The name + description act as the brief. Reasoning-model think
 * tags and whole-document code fences are stripped before writing the file.
 */
async function generateSkill(name, description, model) {
  const { chatOnce } = require('./llamacpp'); // lazy: avoid loading at startup
  let body = await chatOnce({
    model,
    messages: [
      {
        role: 'system',
        content: 'You write skill files for a local LLM studio. A skill is a markdown document injected into the system prompt when active, so write clear, direct instructions addressed to the model that will follow them. Output ONLY the markdown body — no YAML frontmatter, no code fences around the document, no commentary before or after.',
      },
      {
        role: 'user',
        content: `Skill name: ${name.trim()}\nPurpose: ${description.trim()}\n\nWrite the skill instructions with three sections: "## Role" (the expertise to adopt), "## When to use" (what requests it applies to), and "## Guidelines" (concrete, checkable rules — include a short example if output format matters). Keep it under 400 words.`,
      },
    ],
  });
  body = body
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/^\s*```(?:markdown|md)?\s*\n([\s\S]*?)\n\s*```\s*$/g, '$1')
    .trim();
  if (!body) throw new Error('the model returned an empty document — try another model');
  return createSkill(name, description, body);
}

/**
 * Extract a packaged skill archive (.skill — a zip of the skill folder;
 * plain .zip accepted too) into SKILLS_DIR and return its catalog entry.
 * The SKILL.md must sit at the archive root or inside one top-level folder.
 * Every entry path is validated against Zip Slip (../ or absolute paths),
 * and the same size/count caps as folder import apply — checked against
 * declared sizes before extraction AND actual bytes during, so a lying
 * zip bomb can't sneak past. A half-extracted skill is removed on failure.
 */
function importSkillArchive(file, { force, asId } = {}) {
  const AdmZip = require('adm-zip'); // lazy: only loaded when importing archives
  const norm = (p) => p.replace(/\\/g, '/');
  const entries = new AdmZip(file).getEntries().filter(e => !e.isDirectory);

  const skillMd = entries.find(e => /(^|\/)SKILL\.md$/.test(norm(e.entryName)));
  if (!skillMd) throw new Error('no SKILL.md inside the archive');
  const skillParts = norm(skillMd.entryName).split('/');
  if (skillParts.length > 2) throw new Error('SKILL.md must be at the archive root or in one top-level folder');
  const prefix = skillParts.length === 2 ? skillParts[0] + '/' : '';

  const selected = entries.filter(e => norm(e.entryName).startsWith(prefix));
  let declared = 0;
  for (const e of selected) declared += e.header.size;
  if (selected.length > IMPORT_MAX_FILES) throw new Error(`too many files to be a skill (over ${IMPORT_MAX_FILES})`);
  if (declared > IMPORT_MAX_BYTES) throw new Error(`archive too large to be a skill (over ${Math.round(IMPORT_MAX_BYTES / 1e6)} MB)`);

  const id = slugify(asId || (prefix ? prefix.slice(0, -1) : path.basename(file).replace(/\.(skill|zip)$/i, '')));
  if (!id) throw new Error('archive name must contain letters or numbers');
  const dest = path.join(SKILLS_DIR, id);
  const exists = fs.existsSync(path.join(dest, 'SKILL.md'));
  if (exists && !force) throw new Error(`skill "${id}" already exists`);
  if (exists && force) fs.rmSync(dest, { recursive: true, force: true });

  try {
    let written = 0;
    for (const e of selected) {
      const rel = norm(e.entryName).slice(prefix.length);
      if (!rel) continue;
      if (rel.split('/').length > 8) throw new Error('archive is nested too deeply to be a skill');
      const out = path.resolve(dest, rel);
      if (!(out.toLowerCase() + path.sep).startsWith(path.resolve(dest).toLowerCase() + path.sep)) {
        throw new Error('archive contains an unsafe path');
      }
      const data = e.getData();
      written += data.length;
      if (written > IMPORT_MAX_BYTES) throw new Error(`archive too large to be a skill (over ${Math.round(IMPORT_MAX_BYTES / 1e6)} MB)`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, data);
    }
  } catch (e) {
    try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
    throw e;
  }

  return skillEntry(dest, id);
}

/** Read a skill folder's frontmatter into a catalog entry. */
function skillEntry(dir, id) {
  const { meta } = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));
  return { id, name: meta.name || id, description: meta.description || '' };
}

/**
 * Bring an existing skill into SKILLS_DIR and return its catalog entry.
 * Accepts a folder, a SKILL.md file (its parent folder is used), or a
 * packaged .skill/.zip archive — the archive is unpackaged, a folder is
 * copied (never referenced in place, so later edits don't diverge). If the
 * source already lives inside the skills directory it's left as-is and
 * reported with `already: true`. On a name collision, throws unless
 * `force` (overwrite the existing skill) or `asId` (import under a
 * different id instead) is given. Heavy subfolders (node_modules, .git)
 * are skipped.
 */
function importSkill(srcPath, { force, asId } = {}) {
  let src = path.resolve(srcPath);
  if (fs.statSync(src).isFile()) {
    if (/\.(skill|zip)$/i.test(src)) return importSkillArchive(src, { force, asId });
    src = path.dirname(src);
  }
  if (!fs.existsSync(path.join(src, 'SKILL.md'))) throw new Error('no SKILL.md found in that folder');

  const real = fs.realpathSync.native(src).toLowerCase() + path.sep;
  const skillsReal = fs.realpathSync.native(SKILLS_DIR).toLowerCase() + path.sep;
  if (real.startsWith(skillsReal) && !asId) {
    // already in the skills folder — nothing to copy, just surface it
    // (unless the caller wants it re-imported under a different id)
    return { ...skillEntry(src, path.basename(src)), already: true };
  }

  const id = slugify(asId || path.basename(src));
  if (!id) throw new Error('folder name must contain letters or numbers');
  const dest = path.join(SKILLS_DIR, id);
  // force + asId landing back on the source's own folder would otherwise delete
  // src (== dest) before ever copying anything back — treat it as a no-op.
  if (path.resolve(dest).toLowerCase() === path.resolve(src).toLowerCase()) {
    return { ...skillEntry(src, id), already: true };
  }
  const exists = fs.existsSync(path.join(dest, 'SKILL.md'));
  if (exists && !force) throw new Error(`skill "${id}" already exists`);

  const skipHeavy = (p) => !/(^|[\\/])(node_modules|\.git)([\\/]|$)/.test(p);

  /* Size sanity before touching anything: skills are text — a folder that
   * merely contains a SKILL.md next to gigabytes of other data is almost
   * certainly not a skill, and copying it would fill the disk. Checked
   * BEFORE any destructive rmSync below, so an oversized replacement can't
   * wipe out the skill it was meant to replace and leave nothing in its place. */
  let files = 0;
  let bytes = 0;
  (function tally(dir, depth) {
    if (depth > 8) throw new Error('folder is nested too deeply to be a skill');
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (!skipHeavy(full)) continue;
      if (e.isDirectory()) tally(full, depth + 1);
      else if (e.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
        if (files > IMPORT_MAX_FILES) throw new Error(`too many files to be a skill (over ${IMPORT_MAX_FILES})`);
        if (bytes > IMPORT_MAX_BYTES) throw new Error(`folder too large to be a skill (over ${Math.round(IMPORT_MAX_BYTES / 1e6)} MB)`);
      }
    }
  })(src, 0);

  if (exists && force) fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true, filter: skipHeavy });
  return skillEntry(dest, id);
}

/* ---- update / delete ---- */

/**
 * Rewrite an existing skill's description and/or instructions body in place.
 * The id (folder name) never changes — this edits content, not identity.
 * Either argument may be omitted to leave that part as it was. Frontmatter
 * keys beyond name/description (e.g. a Claude Code skill's `allowed-tools`)
 * are carried over untouched, so editing a skill never strips fields this
 * app doesn't itself know about.
 */
function updateSkill(sid, description, body) {
  if (/[\\/]|\.\./.test(sid)) throw new Error('bad skill id');
  const file = path.join(SKILLS_DIR, sid, 'SKILL.md');
  const { meta, body: curBody } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
  const desc = description != null
    ? String(description).trim().replace(/\r?\n/g, ' ') || 'One line describing when to use this skill.'
    : (meta.description || 'One line describing when to use this skill.');
  const nextBody = (body != null ? String(body) : curBody).trim();
  const extra = Object.keys(meta)
    .filter(k => k !== 'name' && k !== 'description')
    .map(k => `${k}: ${meta[k]}`)
    .join('\n');
  const frontmatter = `name: ${meta.name || sid}\ndescription: ${desc}` + (extra ? `\n${extra}` : '');
  fs.writeFileSync(file, `---\n${frontmatter}\n---\n\n${nextBody}\n`);
  return skillEntry(path.join(SKILLS_DIR, sid), sid);
}

/** Delete a skill folder and everything in it. Callers are responsible for
 * dropping the id from any project that had it toggled on. */
function deleteSkill(sid) {
  if (/[\\/]|\.\./.test(sid)) throw new Error('bad skill id');
  const dir = path.join(SKILLS_DIR, sid);
  if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error('skill not found');
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ---- detail view ---- */

/**
 * Full information for one skill: frontmatter, the SKILL.md body, the folder
 * path, and every other file in the folder (references/resources), so the UI
 * can show what a skill contains. File walk is capped for safety.
 */
function skillDetail(sid) {
  if (/[\\/]|\.\./.test(sid)) throw new Error('bad skill id');
  const dir = path.join(SKILLS_DIR, sid);
  const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'));

  const files = [];
  (function walk(d, rel, depth) {
    if (depth > 6 || files.length >= 200) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (/^(node_modules|\.git)$/.test(e.name)) continue;
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r, depth + 1);
      else if (r.toLowerCase() !== 'skill.md') {
        try { files.push({ path: r, size: fs.statSync(path.join(d, e.name)).size }); } catch { /* skip */ }
      }
    }
  })(dir, '', 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { id: sid, meta, body, files, dir };
}

/** Read one reference file inside a skill folder as text (path-confined). */
function skillFile(sid, relPath) {
  if (/[\\/]|\.\./.test(sid)) throw new Error('bad skill id');
  if (typeof relPath !== 'string' || !relPath) throw new Error('missing path');
  const dir = path.resolve(path.join(SKILLS_DIR, sid));
  const target = path.resolve(dir, relPath);
  if (!(target.toLowerCase() + path.sep).startsWith(dir.toLowerCase() + path.sep)) throw new Error('bad path');
  const { readTextFile } = require('./attachments');
  const text = readTextFile(target, 64 * 1024);
  return text === null ? { binary: true } : { text };
}

module.exports = {
  scanSkills, skillBody, createSkill, generateSkill,
  importSkill, skillDetail, skillFile, updateSkill, deleteSkill,
};
