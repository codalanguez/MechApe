/**
 * test-skills.js — path containment around skill folders.
 *
 * A skill is a folder of text files the user may well have downloaded from
 * someone else, and two routes read out of it by path: the detail listing and
 * GET /api/skills/<id>/file. Containment there used to be a string prefix
 * compare on the resolved path, which is fine against ../ and useless against
 * a link — and importSkill copies with fs.cpSync's default dereference:false,
 * so a folder containing a junction arrived with that junction intact.
 *
 * The junction cases skip themselves if the platform or the account won't
 * create one, rather than failing: on Windows `symlinkSync(..., 'junction')`
 * needs no privileges, but a plain file symlink does.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mechape-test-skills-'));
const SKILLS = path.join(tmp, 'skills');
const OUTSIDE = path.join(tmp, 'outside');
fs.mkdirSync(path.join(SKILLS, 'demo', 'refs'), { recursive: true });
fs.mkdirSync(OUTSIDE, { recursive: true });
fs.writeFileSync(path.join(SKILLS, 'demo', 'SKILL.md'), '---\nname: demo\ndescription: d\n---\nbody\n');
fs.writeFileSync(path.join(SKILLS, 'demo', 'refs', 'note.md'), 'a real reference file');
fs.writeFileSync(path.join(OUTSIDE, 'secret.txt'), 'PRIVATE KEY MATERIAL');

process.env.MECHAPE_SKILLS_DIR = SKILLS;
process.env.MECHAPE_DATA_DIR = path.join(tmp, 'projects');
process.env.MECHAPE_LOG_DIR = path.join(tmp, 'logs');
process.env.MECHAPE_FS_ROOTS = '';           // whole disk: containment must not lean on the allowlist

const skills = require('../lib/skills');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
let skipped = 0;

/** Make `link` a junction/symlink to `target`; returns false if not permitted. */
function tryLink(target, link) {
  try {
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch { skipped++; return false; }
}

/* ---- reading a reference file ---- */

test('an ordinary reference file reads fine', () => {
  assert.strictEqual(skills.skillFile('demo', 'refs/note.md').text, 'a real reference file');
});

test('../ out of the skill folder is refused', () => {
  assert.throws(() => skills.skillFile('demo', '../../outside/secret.txt'), /bad path/);
});

test('an absolute path as relPath is refused', () => {
  // path.resolve(dir, '/etc/passwd') discards dir entirely — the reason the
  // containment check has to run on the *result*, not on the input.
  const abs = path.join(OUTSIDE, 'secret.txt');
  assert.throws(() => skills.skillFile('demo', abs), /bad path/);
});

test('a network path is refused before it can reach the filesystem', () => {
  if (process.platform !== 'win32') { skipped++; return; }
  // The message matters: 'bad path' is the lexical branch. Anything else
  // would mean realpath got to see \\host\share first, which is the outbound
  // NTLM handshake this ordering exists to prevent.
  assert.throws(() => skills.skillFile('demo', '\\\\attacker.example\\share\\x'), /bad path/);
});

test('a skill id with separators is refused', () => {
  assert.throws(() => skills.skillFile('../demo', 'refs/note.md'), /bad skill id/);
});

test('a file reached through a junction is refused', () => {
  const link = path.join(SKILLS, 'demo', 'linked');
  if (!tryLink(OUTSIDE, link)) return;
  try {
    // Lexically this is <skills>/demo/linked/secret.txt — inside the folder,
    // and that is exactly what the old prefix compare concluded.
    assert.throws(() => skills.skillFile('demo', 'linked/secret.txt'),
      /points outside the skill folder/);
  } finally { fs.rmSync(link, { recursive: true, force: true }); }
});

test('...and it is not listed in the skill detail either', () => {
  const link = path.join(SKILLS, 'demo', 'linked');
  if (!tryLink(OUTSIDE, link)) return;
  try {
    const listed = skills.skillDetail('demo').files.map(f => f.path);
    assert.ok(listed.includes('refs/note.md'), 'real files should still be listed');
    assert.ok(!listed.some(p => p.startsWith('linked')), `link should not be listed, got ${listed}`);
  } finally { fs.rmSync(link, { recursive: true, force: true }); }
});

/* ---- importing ---- */

test('importing a folder containing a link is refused, and names the entry', () => {
  const src = path.join(tmp, 'incoming');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: incoming\ndescription: d\n---\nbody\n');
  if (!tryLink(OUTSIDE, path.join(src, 'refs'))) return;
  try {
    assert.throws(() => skills.importSkill(src, { asId: 'incoming' }), /shortcut or symbolic link/);
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

test('...and a rejected import leaves the skill it would have replaced intact', () => {
  const src = path.join(tmp, 'incoming2');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: demo\ndescription: replacement\n---\nnew body\n');
  if (!tryLink(OUTSIDE, path.join(src, 'refs'))) return;
  try {
    // force:true is the destructive path — the tally has to run first
    assert.throws(() => skills.importSkill(src, { asId: 'demo', force: true }), /shortcut or symbolic link/);
    assert.strictEqual(skills.skillDetail('demo').body.trim(), 'body', 'the original skill body should survive');
    assert.strictEqual(skills.skillFile('demo', 'refs/note.md').text, 'a real reference file');
  } finally { fs.rmSync(src, { recursive: true, force: true }); }
});

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (skipped) console.log(`\n  (${skipped} check(s) skipped — this platform or account can't create links)`);
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall skill containment tests passed');
})();
