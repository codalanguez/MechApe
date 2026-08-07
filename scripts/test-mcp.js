/**
 * test-mcp.js — unit tests for the MCP host boundary.
 *
 * No child processes and no network: everything here is the parsing and
 * containment logic that sits between a config file the user wrote, a
 * server MechApe did not write, and the model. That boundary is where the
 * interesting failures live — a malformed config, a server that answers
 * with something unexpected, a tool that returns a megabyte.
 *
 * The transport itself (spawn, JSON-RPC framing, handshake) needs a real
 * server to exercise and is not covered here. That gap is deliberate and
 * worth knowing about.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mechape-test-mcp-'));
const cfgPath = path.join(tmp, 'mcp.json');
process.env.MECHAPE_MCP_CONFIG = cfgPath;
process.env.MECHAPE_DATA_DIR = path.join(tmp, 'projects');
process.env.MECHAPE_LOG_DIR = path.join(tmp, 'logs');

const mcp = require('../lib/mcp');
const { parseArgs } = require('../lib/tools');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const writeCfg = (obj) => fs.writeFileSync(cfgPath, JSON.stringify(obj));

/* ---- config parsing ---- */

test('loadConfig: absent file is empty, not an error — no config is the default', () => {
  try { fs.unlinkSync(cfgPath); } catch { /* fine */ }
  assert.deepStrictEqual(mcp.loadConfig(), {});
  assert.strictEqual(mcp.isConfigured(), false);
});

test('loadConfig: reads Claude Desktop format unchanged', () => {
  writeCfg({ mcpServers: { files: { command: 'npx', args: ['-y', 'server-filesystem', '/data'], env: { TOKEN: 'x' } } } });
  const c = mcp.loadConfig();
  assert.deepStrictEqual(c.files, { command: 'npx', args: ['-y', 'server-filesystem', '/data'], env: { TOKEN: 'x' } });
  assert.strictEqual(mcp.isConfigured(), true);
});

test('loadConfig: disabled servers are kept in the file but not started', () => {
  writeCfg({ mcpServers: { on: { command: 'a' }, off: { command: 'b', disabled: true } } });
  assert.deepStrictEqual(Object.keys(mcp.loadConfig()), ['on']);
});

test('loadConfig: a server with no command is skipped, not crashed on', () => {
  writeCfg({ mcpServers: { good: { command: 'a' }, bad: { args: ['x'] }, alsoBad: { command: '   ' } } });
  assert.deepStrictEqual(Object.keys(mcp.loadConfig()), ['good']);
});

test('loadConfig: server names are restricted so they survive the tool-name round-trip', () => {
  // "<server>__<tool>" is split back apart on the way home; a name with odd
  // characters would corrupt that, and would put those characters in a tool
  // name the model sees.
  writeCfg({ mcpServers: { 'ok_name-1': { command: 'a' }, 'bad name': { command: 'b' }, 'bad/slash': { command: 'c' } } });
  assert.deepStrictEqual(Object.keys(mcp.loadConfig()), ['ok_name-1']);
});

test('loadConfig: malformed JSON degrades to no integrations rather than taking the app down', () => {
  fs.writeFileSync(cfgPath, '{ this is not json');
  assert.deepStrictEqual(mcp.loadConfig(), {});
});

test('loadConfig: args and env are coerced, never trusted as-is', () => {
  writeCfg({ mcpServers: { s: { command: 'a', args: 'not-an-array', env: 'nope' } } });
  const c = mcp.loadConfig();
  assert.deepStrictEqual(c.s.args, []);
  assert.deepStrictEqual(c.s.env, {});
});

/* ---- result handling ---- */

test('flatten: joins text parts', () => {
  assert.strictEqual(mcp.flatten({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }), 'a\nb');
});

test('flatten: non-text parts are described, not silently dropped', () => {
  // "there was an image here" is more useful to the model than nothing.
  assert.strictEqual(mcp.flatten({ content: [{ type: 'image', data: '...' }] }), '[image content omitted]');
});

test('flatten: an error result is labelled so the model can react to it', () => {
  const out = mcp.flatten({ isError: true, content: [{ type: 'text', text: 'no such file' }] });
  assert.ok(out.startsWith('Tool reported an error:'), out);
  assert.ok(out.includes('no such file'));
});

test('flatten: an empty result says so rather than returning nothing', () => {
  assert.strictEqual(mcp.flatten({ content: [] }), '(the tool returned nothing)');
  assert.strictEqual(mcp.flatten(null), '(the tool returned nothing)');
});

test('truncate: a runaway tool result is capped and says it was capped', () => {
  const huge = 'x'.repeat(mcp.MAX_RESULT_CHARS + 5000);
  const out = mcp.truncate(huge);
  assert.ok(out.length < huge.length);
  assert.ok(out.includes('truncated'), 'the model must be told the result was cut');
  assert.strictEqual(mcp.truncate('short'), 'short');
});

/* ---- dispatch ---- */

test('callTool: an unknown or unqualified name fails as text, not an exception', async () => {
  // A thrown error here would abort the whole chat; the model should instead
  // read the failure and decide what to do.
  assert.ok((await mcp.callTool('nonsense', {})).startsWith('Error:'));
  assert.ok((await mcp.callTool('ghost__thing', {})).includes('not connected'));
});

/* ---- tool arguments ---- */

test('parseArgs: JSON string, object, and junk all yield an object', () => {
  assert.deepStrictEqual(parseArgs('{"a":1}'), { a: 1 });
  assert.deepStrictEqual(parseArgs({ a: 1 }), { a: 1 });
  // models do emit malformed JSON; an empty object lets the tool complain
  // about missing arguments, which the model can then read and retry
  assert.deepStrictEqual(parseArgs('{not json'), {});
  assert.deepStrictEqual(parseArgs(''), {});
  assert.deepStrictEqual(parseArgs(undefined), {});
});

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall MCP host tests passed');
})();
