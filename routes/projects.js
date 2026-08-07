/**
 * routes/projects.js — REST endpoints for projects, chats, and attachments.
 *
 * CRUD for the project entity and its two nested collections: chats
 * (conversation containers, messages are appended by the chat route) and
 * attachments (path references validated against the filesystem allowlist).
 * All persistence goes through lib/store.
 */
const fs = require('fs');
const express = require('express');
const { newId, loadProject, saveProject, deleteProject, listProjects } = require('../lib/store');
const { pathAllowed } = require('../lib/security');
const { sanitizeOptions } = require('../lib/options');
const { warmAttachment, forgetAttachment } = require('../lib/knowledge');

const router = express.Router();

/** Every attachment in a project (its own + all its chats'). */
function allAttachments(p) {
  const atts = [...(p.attachments || [])];
  for (const c of p.chats || []) atts.push(...(c.attachments || []));
  return atts;
}

/* ---- projects ---- */

router.get('/projects', (req, res) => {
  res.json(listProjects().map(p => ({
    id: p.id, name: p.name, createdAt: p.createdAt,
    chatCount: p.chats.length, skillCount: p.skills.length,
    attachmentCount: p.attachments.length,
  })));
});

router.post('/projects', (req, res) => {
  const p = {
    id: newId(),
    name: (req.body.name || 'Untitled project').slice(0, 120),
    instructions: req.body.instructions || '',
    createdAt: Date.now(),
    skills: [],        // skill ids always loaded for this project
    attachments: [],   // { id, path, type: 'file'|'dir' }
    options: {},       // generation options (num_ctx, temperature, …) — see lib/options.js
    chats: [],         // { id, title, model, createdAt, messages: [{role, content, ts}] }
  };
  saveProject(p);
  res.json(p);
});

router.get('/projects/:pid', (req, res) => {
  try { res.json(loadProject(req.params.pid)); }
  catch { res.status(404).json({ error: 'project not found' }); }
});

router.put('/projects/:pid', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    if (typeof req.body.name === 'string') p.name = req.body.name.slice(0, 120);
    if (typeof req.body.instructions === 'string') p.instructions = req.body.instructions;
    if (Array.isArray(req.body.skills)) {
      p.skills = req.body.skills
        .filter(s => typeof s === 'string' && !/[\\/]|\.\./.test(s))
        .slice(0, 200);
    }
    if (req.body.options && typeof req.body.options === 'object') {
      p.options = sanitizeOptions(req.body.options);
    }
    saveProject(p);
    res.json(p);
  } catch { res.status(404).json({ error: 'project not found' }); }
});

router.delete('/projects/:pid', (req, res) => {
  try {
    let atts = [];
    try { atts = allAttachments(loadProject(req.params.pid)); } catch { /* gone already */ }
    deleteProject(req.params.pid);
    atts.forEach(forgetAttachment); // remove cached embeddings for this project's attachments
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'project not found' }); }
});

/* ---- chats ---- */

router.post('/projects/:pid/chats', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const chat = { id: newId(), title: 'New chat', model: req.body.model || '', createdAt: Date.now(), attachments: [], messages: [] };
    p.chats.unshift(chat);
    saveProject(p);
    res.json(chat);
  } catch { res.status(404).json({ error: 'project not found' }); }
});

router.delete('/projects/:pid/chats/:cid', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const gone = p.chats.find(c => c.id === req.params.cid);
    p.chats = p.chats.filter(c => c.id !== req.params.cid);
    saveProject(p);
    if (gone) (gone.attachments || []).forEach(forgetAttachment);
    res.json({ ok: true });
  } catch { res.status(404).json({ error: 'project not found' }); }
});

router.put('/projects/:pid/chats/:cid', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const c = p.chats.find(chat => chat.id === req.params.cid);
    if (!c) return res.status(404).json({ error: 'chat not found' });
    if (typeof req.body.title === 'string') c.title = req.body.title.slice(0, 120);
    saveProject(p);
    res.json(c);
  } catch { res.status(404).json({ error: 'project not found' }); }
});

/* Pop the last exchange (any trailing assistant replies plus the user message
 * before them) so it can be re-run — the "retry" command. Returns the removed
 * user message so the client can resend it verbatim. */
router.delete('/projects/:pid/chats/:cid/messages/last', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const c = p.chats.find(chat => chat.id === req.params.cid);
    if (!c) return res.status(404).json({ error: 'chat not found' });
    if (!c.messages.some(m => m.role === 'user')) return res.status(400).json({ error: 'nothing to retry' });
    while (c.messages.length && c.messages[c.messages.length - 1].role !== 'user') c.messages.pop();
    const user = c.messages.pop();
    saveProject(p);
    // return the trimmed history too, so the client adopts the server's truth
    // instead of mirroring the pop logic (which could silently drift)
    res.json({ message: user.content, skillIds: user.skillIds || [], messages: c.messages });
  } catch { res.status(404).json({ error: 'project not found' }); }
});

/* "Edit & resend" a past user message: truncate the chat to just before it —
 * that message and everything after it (including its own reply) is about
 * to be regenerated with the edited text. Same "server truth" shape as
 * .../messages/last: the client resends with the trimmed history this
 * returns rather than re-deriving the cut itself. Destructive-only: there's
 * no copy-on-write here, so a future "branch" feature needs its own
 * copy-based sibling rather than reusing this. */
router.delete('/projects/:pid/chats/:cid/messages/from/:idx', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const c = p.chats.find(chat => chat.id === req.params.cid);
    if (!c) return res.status(404).json({ error: 'chat not found' });
    if (!/^\d+$/.test(req.params.idx)) return res.status(400).json({ error: 'not an editable message' });
    const idx = Number(req.params.idx);
    if (!Number.isInteger(idx) || idx < 0 || idx >= c.messages.length || c.messages[idx].role !== 'user') {
      return res.status(400).json({ error: 'not an editable message' });
    }
    c.messages = c.messages.slice(0, idx);
    saveProject(p);
    res.json({ messages: c.messages });
  } catch { res.status(404).json({ error: 'project not found' }); }
});

/* Clear a chat's messages — keeps the chat, its model, and attachments, but
 * wipes the conversation (and so the context it was building up). */
router.delete('/projects/:pid/chats/:cid/messages', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const c = p.chats.find(chat => chat.id === req.params.cid);
    if (!c) return res.status(404).json({ error: 'chat not found' });
    c.messages = [];
    saveProject(p);
    res.json(c);
  } catch { res.status(404).json({ error: 'project not found' }); }
});

/* ---- attachments (knowledge) ----
 * Attachments live at two levels: the project's (shared by all its chats) and
 * a single chat's own (for ad-hoc context, e.g. a quick chat). Both go through
 * the same validation and are merged into the prompt at request time. */

/** Validate a path and return a new attachment entry, or throw. */
function makeAttachment(target) {
  if (typeof target !== 'string' || !target.trim()) throw new Error('missing path');
  if (!pathAllowed(target)) throw new Error('That location is outside MechApe’s allowed folders. Widen access in Preferences → File access.');
  const st = fs.statSync(target);
  return { id: newId(), path: target, type: st.isDirectory() ? 'dir' : 'file' };
}

router.post('/projects/:pid/attachments', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    let att = p.attachments.find(a => a.path === req.body.path);
    if (!att) { att = makeAttachment(req.body.path); p.attachments.push(att); }
    saveProject(p);
    warmAttachment(att); // background index build so the first message doesn't hang
    res.json(p);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

/* Attach several files/folders at once (the file browser's multi-select) —
 * one project write for the whole batch instead of N, and a per-path result
 * so the UI can summarize "attached 6, 2 already there, 1 failed" instead of
 * failing the whole batch over one bad path. Shared by the project- and
 * chat-level batch routes below. Pushes new attachments onto `list` in place
 * — callers must already hold the array they want mutated (p.attachments or
 * c.attachments), it isn't returned. */
function attachBatch(list, rawPaths) {
  const paths = Array.isArray(rawPaths) ? rawPaths.slice(0, 200) : [];
  const results = [];
  const warmed = [];
  for (const path of paths) {
    const existing = list.find(a => a.path === path);
    if (existing) { results.push({ path, ok: true, already: true }); continue; }
    try {
      const att = makeAttachment(path);
      list.push(att);
      warmed.push(att);
      results.push({ path, ok: true });
    } catch (e) { results.push({ path, ok: false, error: String(e.message || e) }); }
  }
  return { results, warmed };
}

router.post('/projects/:pid/attachments/batch', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const { results, warmed } = attachBatch(p.attachments, req.body.paths);
    saveProject(p);
    warmed.forEach(warmAttachment);
    res.json({ project: p, results });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

router.delete('/projects/:pid/attachments/:aid', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const gone = p.attachments.find(a => a.id === req.params.aid);
    p.attachments = p.attachments.filter(a => a.id !== req.params.aid);
    saveProject(p);
    if (gone) forgetAttachment(gone); // remove its cached embeddings copy
    res.json(p);
  } catch { res.status(404).json({ error: 'project not found' }); }
});

/* per-chat attachments — return the updated chat */
router.post('/projects/:pid/chats/:cid/attachments', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const c = p.chats.find(chat => chat.id === req.params.cid);
    if (!c) return res.status(404).json({ error: 'chat not found' });
    if (!c.attachments) c.attachments = [];
    let att = c.attachments.find(a => a.path === req.body.path);
    if (!att) { att = makeAttachment(req.body.path); c.attachments.push(att); }
    saveProject(p);
    warmAttachment(att); // background index build so the first message doesn't hang
    res.json(c);
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

/* Attach several files/folders to a chat at once — see the project-level
 * /attachments/batch above for why this is a separate batch endpoint rather
 * than looping the single one client-side. */
router.post('/projects/:pid/chats/:cid/attachments/batch', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const c = p.chats.find(chat => chat.id === req.params.cid);
    if (!c) return res.status(404).json({ error: 'chat not found' });
    if (!c.attachments) c.attachments = [];
    const { results, warmed } = attachBatch(c.attachments, req.body.paths);
    saveProject(p);
    warmed.forEach(warmAttachment);
    res.json({ chat: c, results });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

router.delete('/projects/:pid/chats/:cid/attachments/:aid', (req, res) => {
  try {
    const p = loadProject(req.params.pid);
    const c = p.chats.find(chat => chat.id === req.params.cid);
    if (!c) return res.status(404).json({ error: 'chat not found' });
    const gone = (c.attachments || []).find(a => a.id === req.params.aid);
    c.attachments = (c.attachments || []).filter(a => a.id !== req.params.aid);
    saveProject(p);
    if (gone) forgetAttachment(gone);
    res.json(c);
  } catch { res.status(404).json({ error: 'project not found' }); }
});

module.exports = router;
