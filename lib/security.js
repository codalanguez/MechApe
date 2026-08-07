/**
 * security.js — request hardening for a localhost-only app.
 *
 * The server binds 127.0.0.1, but a malicious website in the user's own
 * browser can still attack it: DNS rebinding gives an attacker's page a
 * "same-origin" view of localhost, and CSRF fires blind cross-site writes.
 * This module exports:
 *   - securityMiddleware: Host + Origin validation plus hardening headers
 *     (CSP, nosniff, no-referrer), applied to every request.
 *   - pathAllowed: enforces the optional MECHAPE_FS_ROOTS filesystem
 *     allowlist wherever the app touches a user-supplied path.
 */
const fs = require('fs');
const path = require('path');
const { PORT, FS_ROOTS } = require('./config');

const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const ALLOWED_ORIGINS = new Set([`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`]);

function securityMiddleware(req, res, next) {
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: 'forbidden host' });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'forbidden origin' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; " +
    "style-src 'self' 'unsafe-inline'; " +
    "font-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "base-uri 'none'; form-action 'self'; frame-ancestors 'self'; object-src 'none'");
  next();
}

/* Resolve to the true on-disk path — collapses symlinks/junctions and 8.3
 * short names (C:\PROGRA~1) that would otherwise dodge a prefix check. A
 * path that doesn't exist yet (a file about to be written) can't be
 * realpath'd directly, so walk up to the nearest existing ancestor, resolve
 * *that*, and reattach the missing tail — otherwise a new file under a
 * symlinked root (e.g. macOS's /tmp -> /private/tmp) would compare its
 * lexical (unresolved) path against FS_ROOTS entries that realpath *did*
 * resolve, and always lose the prefix check. Iterative (not recursive) and
 * capped at MAX_ASCEND ancestors: a crafted path with thousands of segments
 * would otherwise walk up one stack frame + syscall per segment. */
const MAX_ASCEND = 256;
function realpathish(p) {
  const tail = [];
  let cur = p;
  for (let i = 0; i < MAX_ASCEND; i++) {
    try { return path.join(fs.realpathSync.native(cur), ...tail); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...tail); // filesystem root: nothing left to resolve
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  return path.resolve(p); // absurdly deep path: fail closed on the lexical form
}

function pathAllowed(p) {
  if (!FS_ROOTS.length) return true;
  const full = realpathish(p).toLowerCase() + path.sep;
  return FS_ROOTS.some(root => full.startsWith(realpathish(root).toLowerCase() + path.sep));
}

/* Shared filename validator for anything the app writes into a user-picked
 * folder (save-as, backup zip): rejects path separators, control chars, and
 * the bare "." / ".." special names. */
const SAFE_FILENAME = /^(?!\.{1,2}$)[^\\/:*?"<>|\x00-\x1f]{1,255}$/;

module.exports = { securityMiddleware, pathAllowed, SAFE_FILENAME };
