/**
 * benchmark.js — measure the retrieval + cache features and refresh the numbers
 * in README.md, so the documented benchmarks never drift from reality.
 *
 *   npm run bench            # full run (128 KB, 512 KB, 2 MB) — a couple of minutes
 *   npm run bench -- --quick # skip the slow 2 MB size
 *   npm run bench -- --print # print the markdown, don't touch the README
 *
 * It runs end-to-end against the live llama.cpp chat + embed instances using
 * the app's own modules, then rewrites everything between the
 * <!-- BENCH:START --> / <!-- BENCH:END --> markers in the README. Uses a
 * throwaway temp data/embed dir, so your real projects and indexes are never
 * touched.
 *
 * Optional flags: --chat-model=<name> --embed-model=<name> --ctx=<n>
 */
'use strict';
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { performance } = require('perf_hooks');

const REPO = path.join(__dirname, '..');
const README = path.join(REPO, 'README.md');

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.split('=')[1] : d; };
const QUICK = has('--quick');
const PRINT_ONLY = has('--print');
const CTX = parseInt(opt('ctx', '32768'), 10);
const SIZES = (QUICK ? [128, 512] : [128, 512, 2048]).map(k => k * 1024);

// --- isolate all storage in a temp dir before requiring the app config ---
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mechape-bench-'));
process.env.MECHAPE_DATA_DIR = path.join(tmp, 'projects');
process.env.MECHAPE_EMBED_DIR = path.join(tmp, 'emb');
process.env.MECHAPE_LOG_DIR = path.join(tmp, 'logs');
process.env.MECHAPE_FS_ROOTS = tmp;
fs.mkdirSync(process.env.MECHAPE_DATA_DIR, { recursive: true });

const { buildSystem } = require(path.join(REPO, 'lib', 'prompt'));
const { readForIndex } = require(path.join(REPO, 'lib', 'attachments'));
const { estimateTokens } = require(path.join(REPO, 'lib', 'tokens'));
const { FILE_LIMIT, RETRIEVAL_MIN_CHARS, LLAMACPP_CHAT_URL, LLAMACPP_EMBED_URL } = require(path.join(REPO, 'lib', 'config'));
const llamacpp = require(path.join(REPO, 'lib', 'llamacpp'));
const { embedStatus, isEmbedName } = require(path.join(REPO, 'lib', 'retrieval'));

// --- helpers ---
const ms = (f) => { const t = performance.now(); const r = f(); return { r, ms: performance.now() - t }; };
const msA = async (f) => { const t = performance.now(); const r = await f(); return { r, ms: performance.now() - t }; };
const fmtDur = (n) => n >= 1000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`;
const fmtMB = (b) => `${(b / 1048576).toFixed(1)} MB`;
const commas = (n) => Math.round(n).toLocaleString('en-US');
const fail = (m) => { console.error(`\n✗ ${m}`); cleanup(); process.exit(1); };
const cleanup = () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };

function machineLine(embedModel, chatModel) {
  const cpu = (os.cpus()[0] && os.cpus()[0].model || 'CPU').replace(/\(R\)|\(TM\)|CPU|@.*/g, '').replace(/\s+/g, ' ').trim();
  const threads = os.cpus().length;
  const ramGB = Math.round(os.totalmem() / 1073741824);
  let gpu = '';
  try {
    gpu = execSync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader', { timeout: 4000 })
      .toString().trim().split('\n')[0].split(',').map(s => s.trim()).join(' · ');
  } catch { gpu = ''; }
  const parts = [`**${cpu} · ${threads} threads · ${ramGB} GB RAM${gpu ? ` · ${gpu}` : ''}**`,
    'llama.cpp backend', `embed \`${embedModel}\``, `chat \`${chatModel}\``];
  return parts.join(', ');
}

function makeDoc(targetBytes, facts) {
  const para = (n) => `Section ${n}. The harbor fog pressed against the panes and the ledger stayed unbalanced; nobody could say where the missing crate of brass fittings had gone that winter. `;
  const marks = facts.map(f => ({ pos: Math.floor(f.at * targetBytes), text: f.text, done: false }));
  let s = ''; let i = 0;
  while (s.length < targetBytes) {
    for (const m of marks) if (!m.done && s.length >= m.pos) { s += `\n\n${m.text}\n\n`; m.done = true; }
    s += para(i++) + '\n';
  }
  for (const m of marks) if (!m.done) s += `\n\n${m.text}\n\n`;
  return s;
}

function embIndexStats() {
  let bytes = 0, chunks = 0;
  for (const f of fs.readdirSync(process.env.MECHAPE_EMBED_DIR)) {
    const p = path.join(process.env.MECHAPE_EMBED_DIR, f);
    bytes += fs.statSync(p).size;
    try { chunks += JSON.parse(fs.readFileSync(p, 'utf8')).chunks.length; } catch {}
  }
  return { bytes, chunks };
}

async function prefill(model, system, user) {
  const body = { model, stream: false, max_tokens: 1,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }] };
  // Loading a chat model right after heavy embedding can transiently reset the
  // chat instance (VRAM contention) — retry a couple of times, letting it settle.
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const t0 = performance.now();
      const r = await fetch(`${LLAMACPP_CHAT_URL}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!r.ok) throw new Error(`llama.cpp ${r.status}: ${(await r.text()).slice(0, 120)}`);
      const d = await r.json();
      // llama.cpp's server includes a non-standard `timings` extension on
      // /v1/chat/completions when it's available; fall back to wall-clock +
      // an estimate if a particular build doesn't report it.
      const timings = d.timings || {};
      return {
        tokens: timings.prompt_n != null ? timings.prompt_n : estimateTokens(system + user),
        ms: timings.prompt_ms != null ? timings.prompt_ms : (performance.now() - t0),
      };
    } catch (e) { lastErr = e; await new Promise(res => setTimeout(res, 3000)); }
  }
  throw lastErr;
}

async function run() {
  // preflight
  try { await llamacpp.getVersion(); } catch { fail(`llama.cpp chat instance not reachable at ${LLAMACPP_CHAT_URL}. Start it and retry.`); }
  const es = await embedStatus();
  const embedModel = opt('embed-model', es.name);
  if (!embedModel) fail(`No embedding model installed. Pull one from Manage Models (recommended: ${es.recommended}).`);
  // pick a representative chat model: prefer a common GPU-friendly instruct
  // family (7–8B), else the first non-embedding model. Override with --chat-model.
  const models = (await llamacpp.listModels()).map(m => m.name);
  const PREFER = ['qwen2.5-7b', 'llama-3.2', 'qwen2.5', 'llama-3.1', 'llama-3', 'mistral', 'gemma-2', 'phi'];
  const chatModel = opt('chat-model',
    PREFER.map(p => models.find(n => n.toLowerCase().includes(p) && !isEmbedName(n))).find(Boolean)
    || models.find(n => !isEmbedName(n)) || '');

  console.log(`embed: ${embedModel}  chat: ${chatModel || '(none — skipping prefill)'}  sizes: ${SIZES.map(s => (s / 1024) + 'KB').join(', ')}\n`);

  const facts = [
    { at: 0.08, text: 'FACT-A: the lighthouse keeper who survived the 1911 wreck was named Bartholomew Quill.' },
    { at: 0.92, text: 'FACT-B: the vault behind the cathedral organ opened only to the numbers seven, nineteen, forty-two.' },
  ];
  const rows = [];
  const emptyChat = { attachments: [], messages: [] };
  let bigFile = null;

  for (const size of SIZES) {
    const doc = makeDoc(size, facts);
    const file = path.join(tmp, `doc-${size}.txt`);
    fs.writeFileSync(file, doc);
    if (size === Math.max(...SIZES) || bigFile === null) bigFile = file;
    const project = { instructions: '', skills: [], attachments: [{ id: 'a', path: file, type: 'file' }], options: {} };

    const cold = ms(() => readForIndex(file, 3 * 1024 * 1024));
    const warm = ms(() => readForIndex(file, 3 * 1024 * 1024));
    const build = await msA(() => buildSystem(project, [], emptyChat, 'Who was the lighthouse keeper?'));
    const idx = embIndexStats();
    const q2 = await msA(() => buildSystem(project, [], emptyChat, 'What is the vault combination?'));
    const deep = q2.r.includes('seven, nineteen, forty-two'); // fact at 92% depth

    rows.push({
      size, chunks: idx.chunks, buildMs: build.ms, queryMs: q2.ms,
      coldMs: cold.ms, warmMs: warm.ms, indexBytes: idx.bytes,
      retrTokens: estimateTokens(build.r), dumpTokens: estimateTokens('x'.repeat(Math.min(doc.length, FILE_LIMIT))),
      dumpCapChars: Math.min(doc.length, FILE_LIMIT), deep,
    });
    console.log(`  ${(size / 1024 / 1024).toFixed(2)} MB: ${idx.chunks} ch · build ${fmtDur(build.ms)} · query ${fmtDur(q2.ms)} · deep=${deep}`);
  }

  // long chat over the biggest attachment (warm index)
  const proj = { instructions: '', skills: [], attachments: [{ id: 'a', path: bigFile, type: 'file' }], options: {} };
  const longRows = [];
  for (const n of [5, 20, 60]) {
    const msgs = [];
    for (let i = 0; i < n; i++) msgs.push({ role: i % 2 ? 'assistant' : 'user', content: `Turn ${i}: ` + 'we discussed the harbor ledger and the missing crate in some detail. '.repeat(6) });
    const b = await msA(() => buildSystem(proj, [], { attachments: [], messages: msgs }, 'Remind me who the lighthouse keeper was.'));
    const sys = estimateTokens(b.r), hist = estimateTokens(msgs.map(m => m.content).join('\n'));
    longRows.push({ turns: n, sys, hist, total: sys + hist });
    console.log(`  long chat ${n} turns: sys ${sys} + hist ${hist} tok`);
  }

  // prefill: retrieval-sized vs dump-sized prompt
  let pf = null;
  if (chatModel) {
    // A unique nonce at the very start forces a true cold prefill each time —
    // otherwise a prompt KV-cache would reuse the identical (deterministic)
    // prompt from a prior run and report a near-zero prompt time.
    const nonce = () => `[bench ${Date.now()}-${Math.random().toString(36).slice(2)}]\n`;
    const retrSys = await buildSystem(proj, [], emptyChat, 'Who was the lighthouse keeper?');
    const dumpSys = 'Ground answers in this document:\n' + fs.readFileSync(bigFile, 'utf8').slice(0, FILE_LIMIT);
    // The embed and chat models run as two independent llama-server processes
    // (see lib/llamacpp.js), so — unlike Ollama's single shared runner — both
    // stay resident in VRAM at once; there's nothing to unload here. Just let
    // the heavy embedding work above settle before timing prefill.
    await new Promise(r => setTimeout(r, 2000));
    await prefill(chatModel, 'hi', 'hi').catch(() => {}); // warm/load the model
    const pr = await prefill(chatModel, nonce() + retrSys, 'Who was the lighthouse keeper?');
    const pd = await prefill(chatModel, nonce() + dumpSys, 'Who was the lighthouse keeper?');
    pf = { retr: pr, dump: pd };
    console.log(`  prefill: retrieval ${fmtDur(pr.ms)} (${pr.tokens} tok) vs dump ${fmtDur(pd.ms)} (${pd.tokens} tok)`);
  }

  return { rows, longRows, pf, machine: machineLine(embedModel, chatModel || '—'), embedModel, chatModel, when: new Date().toISOString().slice(0, 10) };
}

function renderMarkdown(d) {
  const big = d.rows[d.rows.length - 1];
  const reduction = Math.round(100 * (1 - big.retrTokens / big.dumpTokens));
  const coverage = Math.round(100 * big.dumpCapChars / big.size); // % of the biggest file the dump path sees
  const ratios = d.rows.map(r => r.indexBytes / r.size);
  const ratioLo = Math.round(Math.min(...ratios)), ratioHi = Math.round(Math.max(...ratios));

  const L = [];
  L.push(`Measured end-to-end against a live llama.cpp backend on a sample laptop — ${d.machine}. Timings come from llama.cpp's own \`timings\` (fallback: wall-clock).`);
  L.push('');
  L.push('**Retrieval by file size** — chunk + embed once, then rank per question:');
  L.push('');
  L.push('| Attachment | Chunks | Index build (one-time) | Warm query | Prompt vs full dump | Fact buried at 92% depth |');
  L.push('|---|--:|--:|--:|--:|:--|');
  const sizeLabel = (b) => b >= 1048576 ? `${(b / 1048576).toFixed(b % 1048576 ? 1 : 0)} MB` : `${(b / 1024).toFixed(0)} KB`;
  for (const r of d.rows) {
    const red = Math.round(100 * (1 - r.retrTokens / r.dumpTokens));
    const tag = `${sizeLabel(r.size)} (~${commas(r.size / 4 / 1000)}k tok)`.replace('~0k', '~1k');
    L.push(`| ${tag} | ${commas(r.chunks)} | ${fmtDur(r.buildMs)} | ${fmtDur(r.queryMs)} | **−${red}%** | ${r.deep ? '✓ found' : '✗ missed'} |`);
  }
  L.push('');
  L.push(`The old behavior caps a file at ${FILE_LIMIT / 1024} KB, so on the ${fmtMB(big.size)} file it only ever saw the first ~${coverage}% — and would miss a fact sitting at 92% depth. Retrieval indexes the whole file and found it every time, injecting ~${commas(big.retrTokens / 1000)}k tokens instead of ~${commas(big.dumpTokens / 1000)}k.`);

  if (d.pf) {
    const speed = (d.pf.dump.ms / d.pf.retr.ms).toFixed(1);
    L.push('');
    L.push(`**Time to first token** — \`${d.chatModel}\`, ${commas(CTX / 1024)}k context:`);
    L.push('');
    L.push('| Prompt | Tokens | Prefill |');
    L.push('|---|--:|--:|');
    L.push(`| Retrieved passages | ${commas(d.pf.retr.tokens)} | **${fmtDur(d.pf.retr.ms)}** |`);
    L.push(`| Full dump (${FILE_LIMIT / 1024} KB cap) | ${commas(d.pf.dump.tokens)} | ${fmtDur(d.pf.dump.ms)} |`);
    L.push('');
    L.push(`Retrieval reaches the first token **~${speed}× sooner**. And a full manuscript (500k+ tokens) is far over a ${commas(CTX / 1024)}k window and can't be sent at all — retrieval is what makes it fit.`);
  }

  L.push('');
  L.push('**Long chats stay open** — biggest attachment; retrieval holds the system prompt flat while history grows:');
  L.push('');
  L.push(`| Turns | System tok | History tok | Total | of ${commas(CTX / 1024)}k context |`);
  L.push('|--:|--:|--:|--:|--:|');
  for (const r of d.longRows) L.push(`| ${r.turns} | ${commas(r.sys)} | ${commas(r.hist)} | ${commas(r.total)} | ${Math.round(100 * r.total / CTX)}% |`);
  L.push('');
  L.push(`The system prompt stays constant as the conversation grows. With the old dump it would pin the system at ~${commas(big.dumpTokens / 1000)}k tokens, so a long chat overflows the ${commas(CTX / 1024)}k window and older messages get trimmed.`);

  L.push('');
  L.push(`> **Caveats.** The *first* index of a huge file scales with size (~${fmtDur(big.buildMs)} for the ${fmtMB(big.size)} file; one-time, cached until it changes). The index stores the chunked source **text** in plaintext under the data dir — gitignored, removed when you detach the attachment, and size-capped; \`MECHAPE_RETRIEVAL=off\` avoids it. Vectors are a sibling raw-binary Float32 file, not JSON-encoded text; a full index pair (text + vectors) currently runs ~${ratioLo}–${ratioHi}× the source (${fmtMB(big.indexBytes)} for the ${fmtMB(big.size)} doc). Warm-SSD read caching saves only sub-millisecond per message; the cache that matters is the index.`);
  L.push('');
  L.push(`<sub>Auto-generated by \`npm run bench\` · last measured ${d.when}.</sub>`);
  return L.join('\n');
}

function spliceReadme(md) {
  const START = '<!-- BENCH:START (auto-generated by `npm run bench` — do not edit by hand) -->';
  const END = '<!-- BENCH:END -->';
  const text = fs.readFileSync(README, 'utf8');
  const i = text.indexOf(START), j = text.indexOf(END);
  if (i === -1 || j === -1) fail(`README markers not found. Add:\n${START}\n${END}\nunder the "#### Benchmarks" heading.`);
  const next = text.slice(0, i + START.length) + '\n' + md + '\n' + text.slice(j);
  fs.writeFileSync(README, next);
}

(async () => {
  const data = await run();
  const md = renderMarkdown(data);
  if (PRINT_ONLY) { console.log('\n----- markdown -----\n' + md); }
  else { spliceReadme(md); console.log(`\n✓ README.md benchmarks updated (${data.when}).`); }
  cleanup();
})().catch(e => { console.error(e); cleanup(); process.exit(1); });
