/**
 * test-memory.js — unit tests for cross-chat memory.
 *
 * No model and no network: the extraction call is stubbed, because what
 * needs testing is everything around it — that a small model's messy JSON is
 * still salvaged, that the store is bounded, that deletion is real, and that
 * turning the feature off actually turns it off.
 *
 * That last one is the important one. A privacy switch that doesn't switch
 * anything is worse than no switch, because it invites trust it hasn't
 * earned.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mechape-test-memory-'));
process.env.MECHAPE_MEMORY_FILE = path.join(tmp, 'memory.json');
process.env.MECHAPE_DATA_DIR = path.join(tmp, 'projects');
process.env.MECHAPE_LOG_DIR = path.join(tmp, 'logs');

const memory = require('../lib/memory');
const { MEMORY_MAX } = require('../lib/config');

const tests = [];
const test = (name, fn) => tests.push([name, fn]);
const reset = () => memory.clear();

/* ---- parsing a small model's output ---- */

test('parseFacts: a clean JSON array', () => {
  assert.deepStrictEqual(memory.parseFacts('["writes horror fiction","uses Windows"]'),
    ['writes horror fiction', 'uses Windows']);
});

test('parseFacts: digs the array out of surrounding prose or a code fence', () => {
  // Small models wrap JSON in explanation constantly. Strict parsing alone
  // would silently throw most real extractions away.
  assert.deepStrictEqual(memory.parseFacts('Sure! Here you go:\n```json\n["likes long sentences"]\n```'),
    ['likes long sentences']);
});

test('parseFacts: the common case — nothing durable — yields nothing', () => {
  assert.deepStrictEqual(memory.parseFacts('[]'), []);
  assert.deepStrictEqual(memory.parseFacts(''), []);
  assert.deepStrictEqual(memory.parseFacts('I could not find anything.'), []);
});

test('parseFacts: non-strings are dropped and the count is capped at 3', () => {
  assert.deepStrictEqual(memory.parseFacts('["a",5,null,"b","c","d","e"]'), ['a', 'b', 'c']);
});

test('parseFacts: an over-long fact is clipped, not discarded', () => {
  const [f] = memory.parseFacts(JSON.stringify([`${'x'.repeat(900)}`]));
  assert.strictEqual(f.length, memory.MAX_FACT_CHARS);
});

/* ---- the store ---- */

test('add: files new facts and reports them', () => {
  reset();
  const added = memory.add(['writes dark fiction', 'uses Windows']);
  assert.strictEqual(added.length, 2);
  assert.strictEqual(memory.list().length, 2);
  assert.ok(added[0].id && added[0].created, 'each fact needs an id and a date');
});

test('add: a fact already known is not filed twice', () => {
  reset();
  memory.add(['uses Windows']);
  assert.deepStrictEqual(memory.add(['USES WINDOWS']), []);
  assert.strictEqual(memory.list().length, 1);
});

test('add: a correction is kept rather than swallowed as a near-duplicate', () => {
  // Dedupe is exact-match on purpose: fuzzier matching would treat this as
  // the same fact and quietly lose the update.
  reset();
  memory.add(['uses Windows']);
  memory.add(['moved to Linux in August']);
  assert.strictEqual(memory.list().length, 2);
});

test('the store is bounded, dropping oldest first', () => {
  reset();
  memory.add(Array.from({ length: 3 }, (_, i) => `old fact ${i}`));
  for (let i = 0; i < MEMORY_MAX; i++) memory.add([`filler ${i}`]);
  const facts = memory.list();
  assert.ok(facts.length <= MEMORY_MAX, `expected <= ${MEMORY_MAX}, got ${facts.length}`);
  assert.ok(!facts.some(f => f.text === 'old fact 0'), 'the oldest should have aged out');
});

test('delete: individual and total, and both are real', () => {
  reset();
  memory.add(['alpha', 'beta']);
  const [first] = memory.list();
  assert.strictEqual(memory.remove(first.id), true);
  assert.strictEqual(memory.remove('nope'), false);
  assert.strictEqual(memory.list().length, 1);
  memory.clear();
  assert.deepStrictEqual(memory.list(), []);
  // and it survives a reload from disk, rather than only clearing in memory
  delete require.cache[require.resolve('../lib/memory')];
  assert.deepStrictEqual(require('../lib/memory').list(), []);
});

/* ---- recall ---- */

test('recall: prefers facts overlapping the question', () => {
  reset();
  memory.add(['writes horror fiction', 'prefers TypeScript', 'lives in Colorado']);
  const [top] = memory.recall('help me with my horror novel');
  assert.strictEqual(top.text, 'writes horror fiction');
});

test('recall: no overlap still returns something, newest first', () => {
  reset();
  memory.add(['fact one']);
  memory.add(['fact two']);
  const got = memory.recall('completely unrelated zebra');
  assert.strictEqual(got[0].text, 'fact two');
});

test('promptBlock: empty when there is nothing, so prompts are unchanged', () => {
  reset();
  assert.strictEqual(memory.promptBlock('anything'), '');
});

test('promptBlock: frames memories as background the user can override', () => {
  reset();
  memory.add(['writes horror fiction']);
  const block = memory.promptBlock('horror');
  assert.ok(block.includes('writes horror fiction'));
  assert.ok(/the user is right/i.test(block), 'a stale memory must lose to what the user says now');
});

/* ---- the off switch ---- */

test('MECHAPE_MEMORY=off extracts nothing and injects nothing', async () => {
  const file = path.join(tmp, 'off-memory.json');
  const off = spawnFresh({ MECHAPE_MEMORY: 'off', MECHAPE_MEMORY_FILE: file });
  off.add(['this was filed directly']);            // the store still works…
  assert.strictEqual(off.promptBlock('this'), '', 'nothing may reach the prompt when off');
  const got = await off.remember({
    userMessage: 'I write horror',
    assistantMessage: 'noted',
    model: 'x',
    chatOnce: async () => { throw new Error('the model must not be called when memory is off'); },
  });
  assert.deepStrictEqual(got, []);
});

/* Load a second copy of the module under different env — config is read at
 * require time, so the switch cannot be flipped in-process. */
function spawnFresh(env) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  for (const m of ['../lib/memory', '../lib/config']) delete require.cache[require.resolve(m)];
  const mod = require('../lib/memory');
  process.env = saved;
  return mod;
}

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall memory tests passed');
})();
