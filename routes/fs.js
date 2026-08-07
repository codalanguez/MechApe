/**
 * routes/fs.js — filesystem browsing, preview, and write-to-disk.
 *
 * Powers the in-app file browser: lists a directory's entries (directories
 * first), exposes a "__drives__" pseudo-directory that enumerates drive
 * letters — or, when MECHAPE_FS_ROOTS is set, the allowed roots instead —
 * and refuses to look outside the allowlist. Also serves a read-only preview
 * of a single file (GET /fs/read) and lets the UI save chat content to disk
 * (POST /fs/write), both fenced by the same allowlist as browsing.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const { FS_ROOTS, PREVIEW_MAX_BYTES, WRITE_MAX_BYTES } = require('../lib/config');
const { pathAllowed, SAFE_FILENAME } = require('../lib/security');

const router = express.Router();

/* Sniff a buffer for binary content: any NUL byte, or more than a tenth of
 * it being non-printable control bytes, means "don't try to render this as
 * text." Scans the WHOLE buffer, not a prefix — `buf` is already bounded to
 * PREVIEW_MAX_BYTES (a couple MB) by the caller, so a full scan costs well
 * under a millisecond, and a partial scan would let binary content past the
 * sample window reach the browser as "text" (garbled control bytes, not a
 * script-injection risk given the client always HTML-escapes, but still a
 * broken preview and a false "this is text" guarantee). 10% tolerates a
 * handful of stray control bytes in an otherwise-normal text/log file. */
function looksBinary(buf) {
  let suspect = 0;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (b === 0) return true;
    if (b < 9 || (b > 13 && b < 32)) suspect++;
  }
  return buf.length > 0 && suspect / buf.length > 0.1;
}

function listDrives() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const d = String.fromCharCode(i) + ':\\';
    try { fs.accessSync(d); drives.push(d); } catch { /* not mounted */ }
  }
  return drives;
}

router.get('/fs', (req, res) => {
  const fallback = FS_ROOTS.length ? FS_ROOTS[0] : os.homedir();
  const dir = req.query.dir || fallback;
  if (dir === '__drives__') {
    // with an allowlist configured, "Drives" shows the allowed roots instead
    const tops = FS_ROOTS.length ? FS_ROOTS : listDrives();
    return res.json({ dir: '__drives__', entries: tops.map(d => ({ name: d, path: d, isDir: true })) });
  }
  if (!pathAllowed(dir)) return res.status(403).json({ error: 'path outside MECHAPE_FS_ROOTS' });
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter(e => !e.name.startsWith('$') && e.name !== 'System Volume Information')
      .map(e => ({ name: e.name, path: path.join(dir, e.name), isDir: e.isDirectory() }))
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
    res.json({ dir: path.resolve(dir), parent: path.dirname(path.resolve(dir)), entries });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

/* Read-only preview of one file: bounded read, binary sniffed and refused
 * (never sent to the client), oversized files truncated rather than fully
 * loaded into memory. */
router.get('/fs/read', (req, res) => {
  const target = typeof req.query.path === 'string' ? req.query.path : '';
  if (!target) return res.status(400).json({ error: 'path required' });
  if (!pathAllowed(target)) return res.status(403).json({ error: 'path outside MECHAPE_FS_ROOTS' });
  let stat;
  try { stat = fs.statSync(target); }
  catch { return res.status(404).json({ error: 'file not found' }); }
  if (!stat.isFile()) return res.status(400).json({ error: 'not a file' });

  const ext = path.extname(target).toLowerCase();
  const readLen = Math.min(stat.size, PREVIEW_MAX_BYTES);
  let buf;
  try {
    const fd = fs.openSync(target, 'r');
    buf = Buffer.alloc(readLen);
    fs.readSync(fd, buf, 0, readLen, 0);
    fs.closeSync(fd);
  } catch (e) { return res.status(400).json({ error: String(e.message || e) }); }

  if (looksBinary(buf)) {
    return res.json({ path: target, ext, size: stat.size, isBinary: true });
  }
  // Node doesn't strip a leading UTF-8 BOM on decode — plenty of real files
  // (anything Notepad or PowerShell wrote) carry one, and it silently breaks
  // markdown heading detection (the '#' isn't the first character anymore).
  let content = buf.toString('utf8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
  res.json({
    path: target, ext, size: stat.size, content,
    truncated: stat.size > readLen,
  });
});

/* Write chat content to disk — "Save as file…". Takes a pre-validated
 * directory plus a single-segment filename (never a combined path: that's
 * what makes the filename regex an airtight traversal guard) and refuses to
 * silently clobber an existing file. */
router.post('/fs/write', (req, res) => {
  const dir = typeof req.body.dir === 'string' ? req.body.dir : '';
  const filename = typeof req.body.filename === 'string' ? req.body.filename.trim() : '';
  const content = typeof req.body.content === 'string' ? req.body.content : '';
  const overwrite = Boolean(req.body.overwrite);

  if (!dir || !filename) return res.status(400).json({ error: 'dir and filename required' });
  if (!SAFE_FILENAME.test(filename)) return res.status(400).json({ error: 'invalid filename' });
  if (!pathAllowed(dir)) return res.status(403).json({ error: 'path outside MECHAPE_FS_ROOTS' });
  let dirStat;
  try { dirStat = fs.statSync(dir); }
  catch { return res.status(404).json({ error: 'folder not found' }); }
  if (!dirStat.isDirectory()) return res.status(400).json({ error: 'not a folder' });

  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > WRITE_MAX_BYTES) {
    return res.status(413).json({ error: `That's ${(bytes / 1024 / 1024).toFixed(1)} MB — files saved from MechApe are capped at ${(WRITE_MAX_BYTES / 1024 / 1024).toFixed(1)} MB.` });
  }

  const target = path.join(dir, filename);
  if (!pathAllowed(target)) return res.status(403).json({ error: 'path outside MECHAPE_FS_ROOTS' }); // defense in depth
  let exists = false;
  try { exists = fs.statSync(target).isDirectory() ? 'dir' : true; } catch { /* doesn't exist — the common case */ }
  if (exists === 'dir') return res.status(400).json({ error: 'a folder with that name already exists there' });
  if (exists && !overwrite) return res.status(409).json({ error: 'A file with that name already exists.', exists: true });

  try { fs.writeFileSync(target, content, 'utf8'); }
  catch (e) { return res.status(400).json({ error: String(e.message || e) }); }
  res.json({ path: target, size: bytes });
});

module.exports = router;
