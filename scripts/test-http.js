/**
 * test-http.js — the real Express stack, over a real socket.
 *
 * test-security.js exercises the guard as a function; this drives it through
 * the app as assembled in server.js, which is the only way to catch an
 * ordering mistake — the security middleware sitting after the body parser,
 * a router mounted ahead of it, an error handler that leaks.
 *
 * It also covers the one contract that spans two modules and had drifted:
 * "Erase everything" is supposed to erase everything, and the memory file
 * lives outside DATA_DIR, so the *.json sweep in routes/backup.js walked past
 * it for as long as the feature existed.
 *
 * Everything runs against a temp DATA_DIR — this never touches real projects.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mechape-test-http-'));
const PORT = 8399;                       // fixed: the guard's allowed Host is built from it
process.env.PORT = String(PORT);
process.env.MECHAPE_DATA_DIR = path.join(tmp, 'projects');
process.env.MECHAPE_LOG_DIR = path.join(tmp, 'logs');
process.env.MECHAPE_SKILLS_DIR = path.join(tmp, 'skills');
process.env.MECHAPE_FS_ROOTS = tmp;
fs.mkdirSync(process.env.MECHAPE_DATA_DIR, { recursive: true });
fs.mkdirSync(process.env.MECHAPE_SKILLS_DIR, { recursive: true });

const { createApp } = require('../server');
const memory = require('../lib/memory');
const { saveProject } = require('../lib/store');

const BASE = `http://127.0.0.1:${PORT}`;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** fetch with the headers our own UI would send, unless overridden. */
function call(p, { headers = {}, ...opts } = {}) {
  return fetch(BASE + p, {
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    ...opts,
  });
}

/* ---- the guard, through the real stack ---- */

test('a cross-site request is refused before it reaches a route', async () => {
  const r = await call('/api/health', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.strictEqual(r.status, 403);
  assert.strictEqual((await r.json()).error, 'forbidden request source');
});

test('a request with no fetch metadata at all is served — curl, and the desktop menu', async () => {
  const r = await fetch(`${BASE}/api/integrations`);
  assert.strictEqual(r.status, 200);
});

test('the static tree is not behind the /api guard', async () => {
  const r = await call('/', { headers: { 'Sec-Fetch-Site': 'cross-site' } });
  assert.strictEqual(r.status, 200);
});

/* Host is a forbidden header name for fetch — it silently drops an override,
 * which made this test pass against the wrong request. Raw http.request is
 * the only way to send the header an attacker actually would. */
function rawGet(p, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method: 'GET', headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('a foreign Host is refused — DNS rebinding', async () => {
  assert.strictEqual(await rawGet('/api/health', { Host: 'evil.example' }), 403);
  // and the ordinary one still works, so the assertion above means something
  assert.strictEqual(await rawGet('/api/health', { Host: `127.0.0.1:${PORT}` }), 200);
});

test('a network path is refused with an explanation, not the allowlist message', async () => {
  if (process.platform !== 'win32') return;
  const r = await call(`/api/fs/read?path=${encodeURIComponent('\\\\attacker.example\\s\\a')}`);
  assert.strictEqual(r.status, 403);
  assert.match((await r.json()).error, /Network locations/);
});

test('a malformed dir query is a clean 400-or-403, never a 500', async () => {
  // ?dir[a]=b parses to an object; it used to reach path.dirname and throw
  const r = await call('/api/fs?dir[a]=b');
  assert.ok(r.status < 500, `expected a client error, got ${r.status}`);
});

/* ---- erase everything ---- */

test('the wrong confirmation phrase erases nothing', async () => {
  memory.clear();
  memory.add(['A durable fact about the user.']);
  const r = await call('/api/wipe', { method: 'POST', body: JSON.stringify({ confirm: 'nope' }) });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(memory.list().length, 1, 'memory must survive a refused wipe');
});

test('"Erase everything" erases the memory profile too', async () => {
  saveProject({ id: 'aaaaaaaaaaaa', name: 'Doomed', chats: [], attachments: [], skills: [] });
  memory.clear();
  memory.add(['Writes fiction.', 'Keeps manuscripts on another drive.']);
  assert.strictEqual(memory.list().length, 2);

  const r = await call('/api/wipe', { method: 'POST', body: JSON.stringify({ confirm: 'ERASE EVERYTHING' }) });
  assert.strictEqual(r.status, 200);
  const body = await r.json();

  // The count is reported so the toast can name it: memory is the part nobody
  // expects to be there, and silently folding it into a total wastes the one
  // moment the user is actually looking.
  assert.strictEqual(body.facts, 2, `expected 2 erased facts, got ${JSON.stringify(body)}`);
  assert.strictEqual(memory.list().length, 0, 'memory.json is outside DATA_DIR — it has to be erased by name');
  assert.strictEqual(fs.readdirSync(process.env.MECHAPE_DATA_DIR).filter(f => f.endsWith('.json')).length, 0);
});

/* ---- memory read contract the Preferences panel depends on ---- */

test('GET /api/memory returns newest first', async () => {
  memory.clear();
  memory.add(['older fact']);
  memory.add(['newer fact']);
  const data = await (await call('/api/memory')).json();
  assert.strictEqual(data.facts[0].text, 'newer fact', 'the panel renders in the order it is given');
  assert.strictEqual(typeof data.max, 'number');
  assert.strictEqual(typeof data.enabled, 'boolean');
});

test('a fact can be deleted by id, and the delete is real', async () => {
  memory.clear();
  memory.add(['forget me']);
  const { facts } = await (await call('/api/memory')).json();
  const r = await call(`/api/memory/${encodeURIComponent(facts[0].id)}`, { method: 'DELETE' });
  assert.strictEqual((await r.json()).ok, true);
  assert.strictEqual(memory.list().length, 0);
});

(async () => {
  const server = createApp().listen(PORT, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  let failures = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  server.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall HTTP stack tests passed');
})();
