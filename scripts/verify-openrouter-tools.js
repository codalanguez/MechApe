/**
 * verify-openrouter-tools.js — live check that remote tool calling works.
 *
 * NOT part of `npm test`: it costs real credits and needs a real key, which
 * is exactly why the rest of the suite stubs the network. Run it by hand
 * after touching the remote tool path.
 *
 *   # PowerShell
 *   $env:MECHAPE_OPENROUTER_KEY = "sk-or-..."
 *   node scripts/verify-openrouter-tools.js
 *
 *   # bash
 *   MECHAPE_OPENROUTER_KEY=sk-or-... node scripts/verify-openrouter-tools.js
 *
 * The key is read from the environment and never printed. Cost is a few
 * hundred tokens against a cheap model — well under a cent.
 *
 * What it proves, in order:
 *   1. the key works at all
 *   2. a tool-capable model asks for the tool we offered, with usable args
 *   3. feeding the result back produces an answer that used it
 *   4. a model that CANNOT call tools degrades to a plain answer rather
 *      than erroring — the failure mode most likely to reach a user
 */
'use strict';

if (!process.env.MECHAPE_OPENROUTER_KEY && !process.env.MONKII_OPENROUTER_KEY) {
  console.error('Set MECHAPE_OPENROUTER_KEY first (see the header of this file). Nothing was sent.');
  process.exit(2);
}

const openrouter = require('../lib/openrouter');

/* A deliberately unguessable answer: if the reply contains it, the model
 * genuinely called the tool rather than reciting something it already knew. */
const SECRET = 'plum-lantern-47';

const TOOLS = [{
  type: 'function',
  function: {
    name: 'vault__read_code',
    description: 'Read the current access code from the vault. The only way to learn it.',
    parameters: { type: 'object', properties: { vault: { type: 'string', description: 'which vault' } }, required: ['vault'] },
  },
}];

const TOOL_CAPABLE = process.env.OR_TOOL_MODEL || 'openrouter:openai/gpt-4o-mini';
const TOOL_INCAPABLE = process.env.OR_NOTOOL_MODEL || 'openrouter:meta-llama/llama-3.2-1b-instruct';

const ask = [
  { role: 'system', content: 'You have tools. Use them when they are the only way to answer.' },
  { role: 'user', content: 'What is the access code in the main vault?' },
];

let failures = 0;
const ok = (label, detail = '') => console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
const bad = (label, detail) => { failures++; console.error(`  FAIL  ${label} — ${detail}`); };

(async () => {
  console.log(`model (tool-capable):   ${TOOL_CAPABLE}`);
  console.log(`model (no tool support): ${TOOL_INCAPABLE}\n`);

  // 1 + 2 — does it ask for the tool?
  let first;
  try {
    first = await openrouter.chatWithTools({ model: TOOL_CAPABLE, messages: ask, tools: TOOLS, options: {} });
  } catch (e) {
    bad('reach OpenRouter', e.message);
    return finish();
  }
  if (first === null) return bad('tool-capable model', 'reported no tool support; pick another with OR_TOOL_MODEL'), finish();
  ok('reached OpenRouter and got a reply');

  const calls = first.tool_calls || [];
  if (!calls.length) {
    bad('model requests the tool', `it answered in prose instead: ${String(first.content).slice(0, 120)}`);
    return finish();
  }
  const call = calls[0];
  const name = call.function && call.function.name;
  if (name !== 'vault__read_code') return bad('tool name round-trips', `got "${name}"`), finish();
  ok('model asked for the tool', name);

  const { parseArgs } = require('../lib/tools');
  const args = parseArgs(call.function.arguments);
  if (typeof args !== 'object') return bad('arguments parse', String(call.function.arguments)), finish();
  ok('arguments parsed', JSON.stringify(args));

  // 3 — feed the result back the way lib/tools.js does
  const history = [...ask, first, {
    role: 'tool',
    tool_call_id: call.id,
    name,
    content: `The access code is ${SECRET}.`,
  }];
  let second;
  try {
    second = await openrouter.chatWithTools({ model: TOOL_CAPABLE, messages: history, tools: TOOLS, options: {} });
  } catch (e) {
    return bad('second turn with the tool result', e.message), finish();
  }
  const answer = String((second && second.content) || '');
  if (answer.includes(SECRET)) ok('answer used the tool result', `found "${SECRET}"`);
  else bad('answer used the tool result', `secret missing from: ${answer.slice(0, 160)}`);

  // 4 — the important negative: a model with no tool support must not error
  let third;
  try {
    third = await openrouter.chatWithTools({ model: TOOL_INCAPABLE, messages: ask, tools: TOOLS, options: {} });
  } catch (e) {
    return bad('no-tool model degrades gracefully', `threw instead of falling back: ${e.message}`), finish();
  }
  if (third === null) ok('no-tool model reported as unsupported', 'the loop will fall back to a plain chat');
  else ok('no-tool model answered anyway', 'it accepted the tools field; also fine');

  finish();
})();

function finish() {
  console.log(failures ? `\n${failures} check(s) failed` : '\nremote tool calling verified');
  process.exit(failures ? 1 : 0);
}
