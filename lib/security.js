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

/* Fetch metadata values that may reach /api. The header is set by the
 * browser on every request it makes and cannot be assigned from script, so
 * unlike Origin it is there even when the request carries nothing else.
 *
 *   same-origin  our own UI — the Electron renderer, or the tab `npm start`
 *                opens. This is the normal case.
 *   none         a user-initiated navigation: typed URL, bookmark, or the
 *                shell opening http://localhost:PORT. Allowed deliberately,
 *                so that hitting /api/health in the address bar still works
 *                while debugging. A page cannot manufacture one — window.open
 *                and location= both produce cross-site.
 *
 * Everything else is refused, including same-site: on loopback the "site" is
 * just localhost, so a page served by some other dev server on another port
 * counts as same-site to us, and that is exactly an attacker here. */
const SAFE_FETCH_SITES = new Set(['same-origin', 'none']);

function securityMiddleware(req, res, next) {
  const host = (req.headers.host || '').toLowerCase();
  if (!ALLOWED_HOSTS.has(host)) return res.status(403).json({ error: 'forbidden host' });
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: 'forbidden origin' });

  /* Origin alone was not enough, and the gap was reachable from any web page
   * the user happened to visit. Browsers omit Origin entirely on subresource
   * GETs, so the check above — which only fires when the header is present —
   * waved through
   *
   *     <img src="http://127.0.0.1:PORT/api/fs/read?path=...">
   *
   * The Host guard still stops DNS rebinding (a browser sends the hostname
   * the attacker typed), so what got through was not arbitrary: every
   * mutation in this app is a POST or DELETE, and those either carry Origin
   * or need a preflight nobody answers. It was read-and-side-effect CSRF
   * rather than write CSRF. That distinction holds only while the REST
   * discipline does, which is why this is a blanket check on the prefix and
   * not a per-route one: the first side-effecting GET added to routes/ turns
   * it back into the other kind.
   *
   * A missing Sec-Fetch-Site means the request came from something that is
   * not a browser — curl, or electron/menu.js building the Projects and
   * Skills menus with a bare Node fetch — and no hostile page can produce
   * that. Allowed, because refusing it would break both for no gain: a local
   * process can forge any header it likes anyway.
   *
   * Scoped to /api so the static tree stays reachable by direct navigation. */
  if (req.path.startsWith('/api/')) {
    const site = req.headers['sec-fetch-site'];
    if (site && !SAFE_FETCH_SITES.has(site)) {
      return res.status(403).json({ error: 'forbidden request source' });
    }
  }
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

/* Windows only. A path naming a network location — \\host\share — makes the
 * SMB redirector authenticate to `host` BEFORE the call fails, handing
 * whoever chose that hostname the user's account name and a crackable
 * NTLM challenge/response. realpathish above is one such call, and it runs
 * inside pathAllowed, so it fired even for paths the allowlist was about to
 * reject — the leak happened on the way to saying no.
 *
 * That forces a decision made on the string alone: by the time we touch the
 * filesystem to find out what a path is, the handshake has already gone out.
 *
 * Two leading separators is the whole test. A UNC path can only be written
 * that way — \\host\share, //host/share, \\?\UNC\..., \\.\... — and
 * path.resolve cannot manufacture that prefix from a drive-letter path, so
 * there is no ../ trick that arrives here without it. Device paths (\\.\PIPE\)
 * fall in the same net, which is where they belong.
 *
 * Mapped network drives are deliberately not caught: Z:\ names no host, the
 * user established that mapping themselves, and both sides of the comparison
 * below go through realpathish, so the \\?\UNC\ form Windows reports for one
 * still matches an allowlist entry. Someone who needs a NAS maps a letter. */
const IS_WINDOWS = process.platform === 'win32';
function isNetworkPath(p) {
  return IS_WINDOWS && /^[\\/]{2}/.test(String(p || ''));
}

/* The one exception: a UNC root the user typed into MECHAPE_FS_ROOTS, or
 * picked in Preferences, names a host they chose — paths under it are theirs
 * to browse. Compared lexically on purpose, since resolving it is the syscall
 * being avoided; sound here because path.resolve cannot climb above
 * \\host\share\, so the worst case stays inside a share already allowed. */
function underNetworkRoot(p) {
  const full = withSep(path.resolve(p).toLowerCase());
  return FS_ROOTS.some(root => isNetworkPath(root)
    && full.startsWith(withSep(path.resolve(root).toLowerCase())));
}

/* Both sides of the prefix compare end in exactly one separator, so that
 * C:\Users\me cannot match C:\Users\me2. Appending one unconditionally is
 * wrong for the paths that already carry it — a root, which is where both
 * path.resolve and realpath put one: "\\\\nas\\media" resolves to
 * "\\\\nas\\media\\" and "C:\\" stays "C:\\". Doubling it made every path
 * under such a root fail the check, which is a fence that quietly denies
 * everything instead of a fence that holds. */
function withSep(p) {
  return p.endsWith(path.sep) ? p : p + path.sep;
}

/**
 * Is `target` inside `root`? Both sides resolved, case-folded, and ending in
 * exactly one separator, so C:\Users\me does not match C:\Users\me2.
 *
 * Case folding is right on Windows and APFS and slightly loose on a
 * case-sensitive filesystem, where /data/Projects and /data/projects are
 * genuinely different directories. Kept because pathAllowed has always
 * compared this way and one containment rule is easier to reason about than
 * two — but the looseness is real and worth knowing about.
 */
function containedIn(root, target) {
  return withSep(String(target).toLowerCase()).startsWith(withSep(String(root).toLowerCase()));
}

function pathAllowed(p) {
  // before anything that touches the disk, and before the whole-disk
  // shortcut below — see isNetworkPath
  if (isNetworkPath(p)) return underNetworkRoot(p);
  if (!FS_ROOTS.length) return true;
  const full = withSep(realpathish(p).toLowerCase());
  return FS_ROOTS.some(root => full.startsWith(withSep(realpathish(root).toLowerCase())));
}

/* Shared filename validator for anything the app writes into a user-picked
 * folder (save-as, backup zip): rejects path separators, control chars, and
 * the bare "." / ".." special names. */
const SAFE_FILENAME = /^(?!\.{1,2}$)[^\\/:*?"<>|\x00-\x1f]{1,255}$/;

module.exports = {
  securityMiddleware, pathAllowed, isNetworkPath, realpathish, containedIn, SAFE_FILENAME,
};
