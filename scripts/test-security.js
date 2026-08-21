/**
 * test-security.js — the request guard and the filesystem allowlist.
 *
 * Both of these decide whether something hostile gets to touch the machine,
 * and both had a hole that only showed up from a direction nobody was
 * looking in:
 *
 *   - the Origin check only fired when the header was present, and browsers
 *     omit it on subresource GETs — so an <img> tag on any web page reached
 *     every GET route on the loopback API;
 *   - pathAllowed resolved a path through the filesystem *before* deciding
 *     whether it was allowed, so a \\host\share path leaked an outbound NTLM
 *     handshake on the way to being rejected.
 *
 * The second one is the reason the UNC assertions below check the *verdict*
 * rather than mocking fs: the property that matters is that no filesystem
 * call happens at all, which is a consequence of the check being purely
 * lexical and sitting above every other branch.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mechape-test-security-'));
process.env.MECHAPE_DATA_DIR = path.join(tmp, 'projects');
process.env.MECHAPE_LOG_DIR = path.join(tmp, 'logs');

const IS_WINDOWS = process.platform === 'win32';
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* FS_ROOTS is read once at require time (lib/config.js), so each allowlist
 * shape needs its own module registry. Cheap, and it keeps the two
 * configurations — fenced and whole-disk — genuinely independent. */
function securityWith(roots) {
  for (const k of Object.keys(require.cache)) {
    if (/[\\/](lib)[\\/](security|config)\.js$/.test(k)) delete require.cache[k];
  }
  if (roots === null) delete process.env.MECHAPE_FS_ROOTS;
  else process.env.MECHAPE_FS_ROOTS = roots;
  return require('../lib/security');
}

/* ---- request provenance (Sec-Fetch-Site) ---- */

/** Run securityMiddleware against a fake request; returns the status, or 0. */
function callGuard(headers, reqPath = '/api/health') {
  const { securityMiddleware } = securityWith(null);
  let status = 0;
  const req = { headers, path: reqPath };
  const res = {
    setHeader() {},
    status(s) { status = s; return this; },
    json() { return this; },
  };
  securityMiddleware(req, res, () => { status = 0; });
  return status;
}

const HOST = { host: `127.0.0.1:${process.env.PORT || 8113}` };

test('a cross-site GET with no Origin is refused — the <img> tag case', () => {
  assert.strictEqual(callGuard({ ...HOST, 'sec-fetch-site': 'cross-site' }), 403);
});

test('same-site is refused too — another dev server on another localhost port', () => {
  assert.strictEqual(callGuard({ ...HOST, 'sec-fetch-site': 'same-site' }), 403);
});

test("our own UI passes", () => {
  assert.strictEqual(callGuard({ ...HOST, 'sec-fetch-site': 'same-origin' }), 0);
});

test('typing the URL into the address bar still works', () => {
  assert.strictEqual(callGuard({ ...HOST, 'sec-fetch-site': 'none' }), 0);
});

test('a non-browser client passes — curl, and electron/menu.js\'s Node fetch', () => {
  assert.strictEqual(callGuard({ ...HOST }), 0);
});

test('the static tree stays reachable cross-site — the guard is /api only', () => {
  assert.strictEqual(callGuard({ ...HOST, 'sec-fetch-site': 'cross-site' }, '/index.html'), 0);
});

test('the host guard still fires first — DNS rebinding', () => {
  assert.strictEqual(callGuard({ host: 'evil.example', 'sec-fetch-site': 'same-origin' }), 403);
});

test('a foreign Origin is still refused', () => {
  assert.strictEqual(callGuard({ ...HOST, origin: 'http://evil.example' }), 403);
});

/* ---- network paths ---- */

test('isNetworkPath catches every spelling of a UNC or device path', () => {
  const { isNetworkPath } = securityWith(null);
  if (!IS_WINDOWS) {
    // On POSIX a leading // is an ordinary path and must stay usable.
    assert.strictEqual(isNetworkPath('//host/share'), false);
    return;
  }
  for (const p of ['\\\\host\\share', '//host/share', '\\/host/share',
    '\\\\?\\UNC\\host\\share', '\\\\.\\PIPE\\x']) {
    assert.strictEqual(isNetworkPath(p), true, `should be a network path: ${p}`);
  }
  for (const p of ['C:\\Users\\me', 'Z:\\mapped', 'relative\\path', '', undefined]) {
    assert.strictEqual(isNetworkPath(p), false, `should not be a network path: ${p}`);
  }
});

test('a UNC path is refused with an allowlist configured', () => {
  if (!IS_WINDOWS) return;
  const { pathAllowed } = securityWith('C:\\Users');
  assert.strictEqual(pathAllowed('\\\\attacker.example\\s\\a'), false);
});

test('...and with no allowlist at all, which is the `npm start` default', () => {
  if (!IS_WINDOWS) return;
  // The regression case. Whole-disk mode returns true without looking at the
  // path, so the network check has to sit ABOVE that shortcut — otherwise the
  // route goes on to call fs.statSync on \\host\share itself.
  const { pathAllowed } = securityWith('');
  assert.strictEqual(pathAllowed('C:\\anything\\at\\all'), true, 'whole-disk mode should still allow ordinary paths');
  assert.strictEqual(pathAllowed('\\\\attacker.example\\s\\a'), false);
});

test('a share the user themselves allowed is usable', () => {
  if (!IS_WINDOWS) return;
  const { pathAllowed } = securityWith('\\\\nas\\media');
  assert.strictEqual(pathAllowed('\\\\nas\\media\\film.mkv'), true);
  assert.strictEqual(pathAllowed('\\\\other\\share\\x'), false);
});

test('...and ../ cannot climb out of it — path.resolve clamps at the share root', () => {
  if (!IS_WINDOWS) return;
  const { pathAllowed } = securityWith('\\\\nas\\media');
  // This is load-bearing: underNetworkRoot compares lexically (resolving is
  // the syscall being avoided), which is only sound because of this clamp.
  assert.strictEqual(path.resolve('\\\\nas\\media\\..\\..\\evil\\x').toLowerCase(), '\\\\nas\\media\\evil\\x');
  assert.strictEqual(pathAllowed('\\\\nas\\media\\..\\..\\evil\\x'), true);
});

test('an allowlist entry that is a bare root still admits what is under it', () => {
  // Regression: a root already ends in a separator, so the prefix compare
  // used to append a second one and match nothing at all. "Allow C:\\" then
  // silently denied every path on C:.
  const root = IS_WINDOWS ? path.parse(tmp).root : '/';
  const { pathAllowed } = securityWith(root);
  assert.strictEqual(pathAllowed(path.join(tmp, 'a.txt')), true);
});

test('ordinary paths are unaffected by the network check', () => {
  const { pathAllowed } = securityWith(tmp);
  assert.strictEqual(pathAllowed(path.join(tmp, 'a.txt')), true);
  assert.strictEqual(pathAllowed(path.join(os.tmpdir(), 'elsewhere.txt')), false);
});

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (!IS_WINDOWS) console.log('\n  (network-path tests are Windows-only and were skipped)');
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall security tests passed');
})();
