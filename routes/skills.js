/**
 * routes/skills.js — REST endpoints for skill discovery and creation.
 *
 * Lets the UI list available skills (for the modal toggles and the "/"
 * invocation popup), fetch a single skill's parsed body, and add skills
 * three ways: blank template scaffold, model-written instructions, or
 * import of an existing folder. Skills live on disk and are rescanned on
 * every request, so dropping a new SKILL.md folder in takes effect without
 * restarting. All creation logic lives in lib/skills.
 */
const express = require('express');
const { SKILLS_DIR } = require('../lib/config');
const {
  scanSkills, skillDetail, skillFile, createSkill, generateSkill, importSkill, updateSkill, deleteSkill,
} = require('../lib/skills');
const { pathAllowed } = require('../lib/security');
const { listProjects, saveProject } = require('../lib/store');

const router = express.Router();

router.get('/skills', (req, res) => res.json({ dir: SKILLS_DIR, skills: scanSkills() }));

/* Scaffold a new skill folder from the built-in template. */
router.post('/skills', (req, res) => {
  try {
    if (typeof req.body.name !== 'string' || !req.body.name.trim()) throw new Error('missing skill name');
    res.json(createSkill(req.body.name, req.body.description));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

/* Copy an existing skill folder (picked in the file browser) into the
 * skills directory. Source must pass the filesystem allowlist. On a name
 * collision the client can retry with `force` (overwrite) or `asId`
 * (import under a different id). */
router.post('/skills/import', (req, res) => {
  try {
    const p = req.body.path;
    if (typeof p !== 'string' || !p.trim()) throw new Error('missing path');
    if (!pathAllowed(p)) throw new Error('path outside MECHAPE_FS_ROOTS');
    res.json(importSkill(p, { force: Boolean(req.body.force), asId: req.body.asId }));
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

/* Scaffold a new skill whose instructions are written by a local model. */
router.post('/skills/generate', async (req, res) => {
  const { name, description, model } = req.body;
  try {
    if (typeof name !== 'string' || !name.trim()) throw new Error('missing skill name');
    if (typeof description !== 'string' || !description.trim()) throw new Error('describe what the skill should do — the model needs a brief');
    if (typeof model !== 'string' || !model.trim()) throw new Error('no model selected');
  } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }

  try {
    res.json(await generateSkill(name, description, model));
  } catch (e) {
    require('../lib/log').logError(`skill generate "${name}" with "${model}"`, e);
    res.status(502).json({ error: String(e.message || e) });
  }
});

/* Full skill info for the detail view: frontmatter, body, reference files. */
router.get('/skills/:sid', (req, res) => {
  try { res.json(skillDetail(req.params.sid)); }
  catch { res.status(404).json({ error: 'skill not found' }); }
});

/* One reference file's text content, for inline preview in the detail view. */
router.get('/skills/:sid/file', (req, res) => {
  try { res.json(skillFile(req.params.sid, req.query.path)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

/* Rewrite a skill's description and/or instructions in place — id unchanged. */
router.put('/skills/:sid', (req, res) => {
  try { res.json(updateSkill(req.params.sid, req.body.description, req.body.body)); }
  catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

/* Delete a skill folder entirely, and drop it from any project that had it
 * toggled always-on — otherwise a stale id would linger in project.skills. */
router.delete('/skills/:sid', (req, res) => {
  try {
    deleteSkill(req.params.sid);
    for (const p of listProjects()) {
      if (!(p.skills || []).includes(req.params.sid)) continue;
      p.skills = p.skills.filter(id => id !== req.params.sid);
      saveProject(p);
    }
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

module.exports = router;
