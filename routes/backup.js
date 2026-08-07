/**
 * routes/backup.js — one-click backup and wipe for local data.
 *
 * Backup zips DATA_DIR (projects + chats — the store the JSON files already
 * live in trivially, see lib/store.js) to a folder the caller picks, fenced
 * by the same MECHAPE_FS_ROOTS allowlist and filename rules as /fs/write.
 * Cached retrieval indexes aren't included: they're a rebuildable cache, not
 * source data (see lib/retrieval.js).
 *
 * Wipe clears DATA_DIR and EMBED_DIR in place — every project/chat and every
 * cached embedding — leaving the folders themselves (so the app keeps
 * working right after) and leaving skills and storage-location settings
 * untouched entirely. It requires an exact confirmation phrase in the body
 * as a server-side backstop, not just a client-side dialog.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const AdmZip = require('adm-zip');
const { DATA_DIR, EMBED_DIR } = require('../lib/config');
const { pathAllowed, SAFE_FILENAME } = require('../lib/security');
const { dropAll } = require('../lib/retrieval');

const router = express.Router();

const WIPE_PHRASE = 'ERASE EVERYTHING';

function countJsonFiles(dir) {
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.json')).length; }
  catch { return 0; }
}

function dirBytes(dir) {
  let bytes = 0;
  try { for (const f of fs.readdirSync(dir)) { try { bytes += fs.statSync(path.join(dir, f)).size; } catch { /* raced away */ } } }
  catch { /* no dir yet */ }
  return bytes;
}

router.get('/backup/info', (req, res) => {
  res.json({
    dataDir: DATA_DIR,
    projectCount: countJsonFiles(DATA_DIR),
    embedDir: EMBED_DIR,
    embedBytes: dirBytes(EMBED_DIR),
  });
});

router.post('/backup', (req, res) => {
  const dir = typeof req.body.dir === 'string' ? req.body.dir : '';
  const filename = typeof req.body.filename === 'string' ? req.body.filename.trim() : '';
  if (!dir || !filename) return res.status(400).json({ error: 'dir and filename required' });
  if (!SAFE_FILENAME.test(filename) || !filename.toLowerCase().endsWith('.zip')) {
    return res.status(400).json({ error: 'invalid filename' });
  }
  if (!pathAllowed(dir)) return res.status(403).json({ error: 'path outside MECHAPE_FS_ROOTS' });
  let dirStat;
  try { dirStat = fs.statSync(dir); }
  catch { return res.status(404).json({ error: 'folder not found' }); }
  if (!dirStat.isDirectory()) return res.status(400).json({ error: 'not a folder' });

  const target = path.join(dir, filename);
  if (!pathAllowed(target)) return res.status(403).json({ error: 'path outside MECHAPE_FS_ROOTS' }); // defense in depth
  if (fs.existsSync(target)) return res.status(409).json({ error: 'A file with that name already exists.', exists: true });

  let projectFiles = [];
  try { projectFiles = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json')); } catch { /* no data dir yet */ }

  try {
    const zip = new AdmZip();
    for (const f of projectFiles) zip.addLocalFile(path.join(DATA_DIR, f), 'projects');
    zip.writeZip(target);
  } catch (e) { return res.status(500).json({ error: String(e.message || e) }); }

  res.json({ path: target, projects: projectFiles.length });
});

router.post('/wipe', (req, res) => {
  if (req.body.confirm !== WIPE_PHRASE) {
    return res.status(400).json({ error: `type "${WIPE_PHRASE}" to confirm` });
  }
  // drop every in-flight/tracked build FIRST: a background embed that's mid-flight
  // right now would otherwise finish after the unlinks below and write its index
  // pair straight back to EMBED_DIR, silently resurrecting content this just erased.
  dropAll();
  let projects = 0, embeddings = 0;
  try {
    for (const f of fs.readdirSync(DATA_DIR)) {
      if (!f.endsWith('.json')) continue;
      try { fs.unlinkSync(path.join(DATA_DIR, f)); projects++; } catch { /* raced away */ }
    }
  } catch { /* no data dir yet */ }
  try {
    for (const f of fs.readdirSync(EMBED_DIR)) {
      // count index pairs, not files: each build writes a .json + a .bin
      if (f.endsWith('.json')) embeddings++;
      try { fs.unlinkSync(path.join(EMBED_DIR, f)); } catch { /* raced away */ }
    }
  } catch { /* no embed dir yet */ }
  res.json({ ok: true, projects, embeddings });
});

module.exports = router;
