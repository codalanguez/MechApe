/**
 * test-llamacpp.js — unit tests for the llama.cpp adapter boundary.
 *
 * `npm test` runs this alongside test-openrouter.js. No framework, no
 * network, no real llama-server or GGUF file: exercises mapOptions (Ollama
 * -> llama-server option translation), the Hugging Face spec/filename
 * parsing (parseSpec, safeGgufName), path resolution (resolveModelPath —
 * the one gate between a client-supplied model name and the filesystem),
 * lib/download.js's shared download loop (atomic rename, size cap, cleanup
 * on failure — the piece both the model puller and the llama-server binary
 * installer depend on), and lib/gguf.js's bounds-checked header reader
 * against synthetic byte buffers, including truncated/malformed ones — the
 * one piece of this adapter that touches attacker-controllable bytes (a
 * file a user could drop into the models folder). Exits non-zero on any
 * failure.
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// isolate storage before any app module reads config at require-time
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mechape-test-llamacpp-'));
process.env.MECHAPE_MODELS_DIR = path.join(tmp, 'models');
process.env.MECHAPE_LOG_DIR = path.join(tmp, 'logs');
process.env.MECHAPE_DATA_DIR = path.join(tmp, 'projects');

const llamacpp = require('../lib/llamacpp');
const gguf = require('../lib/gguf');
const { streamToFile } = require('../lib/download');
const { parseDevices, variantChain, accelLabel, pickDevice, anyNvidia } = require('../lib/accel');

const tests = [];
function test(name, fn) { tests.push([name, fn]); }

/* ---- lib/download.js: the loop shared by the model puller and the
 * llama-server binary installer — atomic rename, size cap, cleanup on failure ---- */

function bodyOf(chunks) {
  const enc = new TextEncoder();
  return new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
}

test('streamToFile: writes the destination and cleans up the .part file on success', async () => {
  const dest = path.join(tmp, 'download-ok.bin');
  await streamToFile(bodyOf(['hello ', 'world']), dest, { total: 11 });
  assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'hello world');
  assert.ok(!fs.existsSync(dest + '.part'), '.part file must not survive a successful download');
});

test('streamToFile: reports progress as bytes arrive', async () => {
  const dest = path.join(tmp, 'download-progress.bin');
  const seen = [];
  await streamToFile(bodyOf(['aa', 'bb', 'cc']), dest, { total: 6, onProgress: (done, total) => seen.push([done, total]) });
  assert.deepStrictEqual(seen, [[2, 6], [4, 6], [6, 6]]);
});

test('streamToFile: enforces maxBytes and leaves no partial file behind', async () => {
  const dest = path.join(tmp, 'download-toobig.bin');
  await assert.rejects(
    () => streamToFile(bodyOf(['x'.repeat(10)]), dest, { maxBytes: 5 }),
    /safety size cap/,
  );
  assert.ok(!fs.existsSync(dest), 'destination must not exist after a capped download');
  assert.ok(!fs.existsSync(dest + '.part'), '.part file must be cleaned up after a capped download');
});

test('streamToFile: beforeRename runs after the write completes but before the rename', async () => {
  const dest = path.join(tmp, 'download-hook.bin');
  const order = [];
  await streamToFile(bodyOf(['data']), dest, {
    beforeRename: async () => { order.push(fs.existsSync(dest + '.part') && !fs.existsSync(dest) ? 'pre-rename' : 'wrong-order'); },
  });
  assert.deepStrictEqual(order, ['pre-rename']);
  assert.ok(fs.existsSync(dest));
});

/* ---- lib/accel.js: which build to run, and what it's running on ----
 * parseDevices decides whether every user gets a GPU build or the CPU one,
 * so its failure modes matter more than its happy path. The asymmetry it
 * must respect: wrongly reporting "no GPU" silently halves a working
 * machine's speed, while wrongly reporting "GPU" just defers to the
 * load-time CPU fallback. Every ambiguous case below must therefore come
 * out on the "keep the GPU build" side. */

// what a real CUDA machine prints — note the init logs on stderr first, and
// the "Device 0:" line ABOVE the header that must not be counted twice
const CUDA_OUTPUT = `ggml_cuda_init: found 1 CUDA devices:
  Device 0: NVIDIA GeForce RTX 3070 Laptop GPU, compute capability 8.6, VMM: yes
Available devices:
  CUDA0: NVIDIA GeForce RTX 3070 Laptop GPU (8192 MiB, 7245 MiB free)`;

test('parseDevices: finds a CUDA GPU in real --list-devices output', () => {
  const { recognized, gpus } = parseDevices(CUDA_OUTPUT);
  assert.strictEqual(recognized, true);
  assert.strictEqual(gpus.length, 1);
  assert.strictEqual(gpus[0].backend, 'CUDA');
  assert.match(gpus[0].name, /RTX 3070/);
});

test('parseDevices: finds a Vulkan GPU (AMD/Intel path)', () => {
  const { recognized, gpus } = parseDevices(
    'Available devices:\n  Vulkan0: AMD Radeon RX 7900 XT (20464 MiB, 20464 MiB free)',
  );
  assert.strictEqual(recognized, true);
  assert.deepStrictEqual(gpus.map(g => g.backend), ['Vulkan']);
});

test('parseDevices: finds every GPU in a multi-GPU listing', () => {
  const { gpus } = parseDevices(
    'Available devices:\n  CUDA0: NVIDIA A (1 MiB, 1 MiB free)\n  CUDA1: NVIDIA B (1 MiB, 1 MiB free)',
  );
  assert.deepStrictEqual(gpus.map(g => g.index), [0, 1]);
});

test('parseDevices: a GPU build on a machine with no GPU is a real "none" verdict', () => {
  // the case this whole probe exists for: the CUDA build launches fine (its
  // DLLs are bundled) but enumerates nothing — previously invisible until a
  // model load crashed mid-chat
  const { recognized, gpus } = parseDevices('Available devices:\n');
  assert.strictEqual(recognized, true);
  assert.strictEqual(gpus.length, 0, 'must be a definite "no GPU here", not an unknown');
});

test('parseDevices: a bare CPU device line does not count as a GPU', () => {
  const { recognized, gpus } = parseDevices('Available devices:\n  CPU: 11th Gen Intel Core i9-11900H');
  assert.strictEqual(recognized, true);
  assert.strictEqual(gpus.length, 0, 'a CPU entry has no trailing index and is not an accelerator');
});

test('parseDevices: FAILS OPEN on output it does not understand', () => {
  // a reformatted future llama.cpp, a crash before printing, an empty pipe —
  // none of these are evidence of "no GPU", and treating them as such would
  // quietly downgrade working machines
  for (const unknown of ['', null, undefined, 'error while loading shared libraries', '{"devices":[]}']) {
    const { recognized, gpus } = parseDevices(unknown);
    assert.strictEqual(recognized, false, `must return no verdict for ${JSON.stringify(unknown)}`);
    assert.deepStrictEqual(gpus, []);
  }
});

test('parseDevices: a blank line after the header does not hide the GPUs below it', () => {
  // guards the "stop scanning at the first blank line" simplification, which
  // reads tidier but biases toward the harmful direction
  const { gpus } = parseDevices('Available devices:\n\n  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 24000 MiB free)');
  assert.strictEqual(gpus.length, 1);
});

test('variantChain: CUDA leads on NVIDIA, Vulkan elsewhere, CPU always last', () => {
  assert.deepStrictEqual(variantChain('win32', { hasNvidia: true }), ['cuda', 'vulkan', 'cpu'],
    'an NVIDIA card should get CUDA — Vulkan measured worse than CPU there');
  assert.deepStrictEqual(variantChain('win32', { hasNvidia: false }), ['vulkan', 'cpu'],
    'AMD/Intel must not be sent to fetch 640 MB of a build that cannot see their GPU');
  for (const chain of [variantChain('win32', { hasNvidia: true }), variantChain('win32')]) {
    assert.strictEqual(chain[chain.length - 1], 'cpu', 'the always-works build must be the final fallback');
  }
  assert.deepStrictEqual(variantChain('darwin'), ['metal']); // Metal is compiled into the macOS build
  assert.deepStrictEqual(variantChain('linux'), ['cpu']);    // only a CPU asset in the pinned release
});

test('variantChain: opting out keeps an NVIDIA machine on the bundled build', () => {
  assert.deepStrictEqual(variantChain('win32', { hasNvidia: true, cudaOptOut: true }), ['vulkan', 'cpu']);
});

test('anyNvidia: recognises NVIDIA cards and is not fooled by other vendors', () => {
  const nv = parseDevices(LAPTOP_OUTPUT).gpus;               // Intel iGPU + RTX 3070
  assert.strictEqual(anyNvidia(nv), true, 'must spot the NVIDIA card even alongside an Intel iGPU');
  const amd = parseDevices('Available devices:\n  Vulkan0: AMD Radeon RX 7900 XT (20464 MiB, 20464 MiB free)').gpus;
  assert.strictEqual(anyNvidia(amd), false);
  const intel = parseDevices('Available devices:\n  Vulkan0: Intel(R) UHD Graphics (32618 MiB, 48085 MiB free)').gpus;
  assert.strictEqual(anyNvidia(intel), false);
  assert.strictEqual(anyNvidia([]), false, 'no devices means no NVIDIA, not an assumption either way');
});

/* ---- device selection: which GPU to actually offload to ---- */

// verbatim from the dev laptop — the iGPU enumerates FIRST and reports 4x the
// memory (it shares system RAM), so both "take device 0" (llama.cpp's own
// default) and "take the most memory" pick the slow one
const LAPTOP_OUTPUT = `Available devices:
  Vulkan0: Intel(R) UHD Graphics (32618 MiB, 48085 MiB free)
  Vulkan1: NVIDIA GeForce RTX 3070 Laptop GPU (8018 MiB, 7250 MiB free)`;

test('parseDevices: pulls the id, name, and memory off each device line', () => {
  const { gpus } = parseDevices(LAPTOP_OUTPUT);
  assert.deepStrictEqual(gpus.map(g => g.id), ['Vulkan0', 'Vulkan1']);
  assert.strictEqual(gpus[1].name, 'NVIDIA GeForce RTX 3070 Laptop GPU', 'the memory suffix must not bleed into the name');
  assert.strictEqual(gpus[1].totalMiB, 8018);
  assert.strictEqual(gpus[1].freeMiB, 7250);
});

test('pickDevice: chooses the discrete GPU over an integrated one that claims more memory', () => {
  const { gpus } = parseDevices(LAPTOP_OUTPUT);
  const picked = pickDevice(gpus);
  assert.strictEqual(picked.id, 'Vulkan1');
  assert.match(picked.name, /3070/, 'must not pick the Intel iGPU just because it reports more (shared) memory');
});

test('pickDevice: among same-class GPUs, more VRAM wins', () => {
  const { gpus } = parseDevices(
    'Available devices:\n  CUDA0: NVIDIA RTX 3060 (12288 MiB, 12000 MiB free)\n  CUDA1: NVIDIA RTX 4090 (24564 MiB, 24000 MiB free)',
  );
  assert.strictEqual(pickDevice(gpus).id, 'CUDA1');
});

test('pickDevice: a software rasterizer ranks below anything real', () => {
  const { gpus } = parseDevices(
    'Available devices:\n  Vulkan0: llvmpipe (LLVM 15, 256 bits) (16000 MiB, 16000 MiB free)\n  Vulkan1: AMD Radeon RX 7900 XT (20464 MiB, 20464 MiB free)',
  );
  assert.strictEqual(pickDevice(gpus).id, 'Vulkan1');
});

test('pickDevice: no devices means no choice to make', () => {
  assert.strictEqual(pickDevice([]), null);
  assert.strictEqual(pickDevice(null), null);
});

test('accelLabel: known variants map to display names, unknown falls back to CPU', () => {
  assert.strictEqual(accelLabel('cuda'), 'CUDA');
  assert.strictEqual(accelLabel('vulkan'), 'Vulkan');
  assert.strictEqual(accelLabel('metal'), 'Metal');
  assert.strictEqual(accelLabel('cpu'), 'CPU');
  assert.strictEqual(accelLabel('something-new'), 'CPU');
});

/* ---- the GPU -> CPU load-failure fallback plan ---- */

test('planOffloadAttempts: tries the GPU first, then CPU, when not degraded', () => {
  assert.deepStrictEqual(llamacpp.planOffloadAttempts(999, false), [999, 0]);
});

test('planOffloadAttempts: stops retrying the GPU once this session has degraded', () => {
  // otherwise every respawn after the first failure re-pays the cost of a
  // load that has already been shown not to work on this machine
  assert.deepStrictEqual(llamacpp.planOffloadAttempts(999, true), [0]);
});

test('planOffloadAttempts: an explicit -ngl 0 is honored, with no pointless GPU attempt', () => {
  assert.deepStrictEqual(llamacpp.planOffloadAttempts(0, false), [0]);
});

/* ---- mapOptions: Ollama-shaped -> llama-server's extended OpenAI body ---- */

test('mapOptions: translates known knobs, drops num_ctx/keep_alive/or_route', () => {
  const out = llamacpp.mapOptions({
    temperature: 0.8, top_p: 0.9, top_k: 40, min_p: 0.05, seed: 7,
    stop: ['\n', 'user:'], num_predict: 256, repeat_penalty: 1.1, repeat_last_n: 64,
    mirostat: 2, mirostat_eta: 0.1, mirostat_tau: 5,
    num_ctx: 16384, keep_alive: '5m', or_route: 'floor',
  });
  assert.strictEqual(out.temperature, 0.8);
  assert.strictEqual(out.max_tokens, 256); // num_predict -> max_tokens
  assert.strictEqual(out.repeat_penalty, 1.1);
  assert.strictEqual(out.mirostat, 2);
  assert.deepStrictEqual(out.stop, ['\n', 'user:']);
  for (const k of ['num_ctx', 'keep_alive', 'or_route', 'num_predict']) {
    assert.ok(!(k in out), `${k} must not reach the request body — num_ctx is a launch flag, not a per-request option`);
  }
});

test('mapOptions: num_predict <= 0 is omitted (means "no limit" upstream, not max_tokens:0)', () => {
  assert.ok(!('max_tokens' in llamacpp.mapOptions({ num_predict: 0 })));
  assert.ok(!('max_tokens' in llamacpp.mapOptions({ num_predict: -1 })));
});

test('mapOptions: empty/absent input yields an empty body', () => {
  assert.deepStrictEqual(llamacpp.mapOptions({}), {});
  assert.deepStrictEqual(llamacpp.mapOptions(), {});
});

/* ---- parseSpec: "<hf-repo>[:quant]" ---- */

test('parseSpec: bare repo defaults to Q4_K_M', () => {
  assert.deepStrictEqual(llamacpp.parseSpec('bartowski/Llama-3.2-3B-Instruct-GGUF'), {
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', quant: 'Q4_K_M',
  });
});

test('parseSpec: explicit quant, case-insensitive', () => {
  assert.deepStrictEqual(llamacpp.parseSpec('bartowski/Llama-3.2-3B-Instruct-GGUF:q8_0'), {
    repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', quant: 'Q8_0',
  });
});

test('parseSpec: a colon before the repo\'s "/" is not mistaken for a quant separator', () => {
  // pathological input a naive lastIndexOf(':') split would mangle
  const { repo } = llamacpp.parseSpec('weird:name/repo');
  assert.strictEqual(repo, 'weird:name/repo');
});

/* ---- safeGgufName: the gate between an HF listing and a filesystem write ---- */

test('safeGgufName: accepts a plain .gguf filename', () => {
  assert.strictEqual(llamacpp.safeGgufName('model-Q4_K_M.gguf'), 'model-Q4_K_M.gguf');
});

test('safeGgufName: rejects traversal, nested paths, and non-.gguf files', () => {
  for (const bad of ['../evil.gguf', 'sub/dir.gguf', 'sub\\dir.gguf', 'model.exe', '..\\..\\evil.gguf', '', null, undefined]) {
    assert.strictEqual(llamacpp.safeGgufName(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

/* ---- resolveModelPath: client-supplied name -> path, or refusal ---- */

test('resolveModelPath: a bare filename resolves inside MODELS_DIR', () => {
  const p = llamacpp.resolveModelPath('model.gguf');
  assert.ok(p && path.dirname(p) === path.resolve(process.env.MECHAPE_MODELS_DIR));
});

test('resolveModelPath: rejects traversal and separators', () => {
  for (const bad of ['../outside.gguf', 'sub/model.gguf', 'sub\\model.gguf', '..\\..\\evil.gguf', '', null]) {
    assert.strictEqual(llamacpp.resolveModelPath(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('resolveModelPath: rejects NTFS alternate-data-stream syntax and non-.gguf names', () => {
  // a security-review finding: ":" isn't a path separator, so path.dirname()
  // alone doesn't catch "model.gguf:hidden" — this must be rejected explicitly
  for (const bad of ['model.gguf:hidden', 'model.gguf:$DATA', 'notes.txt', 'model.exe']) {
    assert.strictEqual(llamacpp.resolveModelPath(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

/* ---- lib/gguf.js: bounds-checked header reader over synthetic buffers ---- */

const TYPE = { UINT32: 4, STRING: 8 };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const ggufString = (s) => { const sb = Buffer.from(s, 'utf8'); return Buffer.concat([u64(sb.length), sb]); };

/** Build a minimal valid GGUF buffer: magic, version 3, 0 tensors, then the
 * given [key, type, valueBuf] metadata entries. */
function buildGguf(entries) {
  const parts = [Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(entries.length)];
  for (const [key, type, valueBuf] of entries) parts.push(ggufString(key), u32(type), valueBuf);
  return Buffer.concat(parts);
}

function writeTemp(name, buf) {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, buf);
  return p;
}

test('gguf: reads architecture + context_length from a well-formed file', async () => {
  const buf = buildGguf([
    ['general.architecture', TYPE.STRING, ggufString('llama')],
    ['llama.context_length', TYPE.UINT32, u32(4096)],
  ]);
  const p = writeTemp('valid-Q4_K_M.gguf', buf);
  const info = await gguf.describeModel(p, 'valid-7B-Q4_K_M.gguf');
  assert.strictEqual(info.architecture, 'llama');
  assert.strictEqual(info.contextLength, 4096);
  assert.strictEqual(info.parameterSize, '7B');       // metadata absent -> filename fallback
  assert.strictEqual(info.quantization, 'Q4_K_M');    // metadata absent -> filename fallback
  assert.strictEqual(info.isEmbedding, false);
});

test('gguf: a file with wrong magic bytes is rejected, not crashed on', async () => {
  const p = writeTemp('bad-magic.gguf', Buffer.from('NOPE' + 'x'.repeat(60)));
  assert.deepStrictEqual(await gguf.readMeta(p), {});
});

test('gguf: a header truncated mid-metadata returns gracefully, no throw', async () => {
  const full = buildGguf([['general.architecture', TYPE.STRING, ggufString('llama')]]);
  const truncated = full.subarray(0, full.length - 3); // cut off mid string value
  const p = writeTemp('truncated.gguf', truncated);
  await assert.doesNotReject(() => gguf.readMeta(p));
  const meta = await gguf.readMeta(p);
  assert.ok(!('general.architecture' in meta)); // the partial entry never completed
});

test('gguf: a pathological metadata-kv-count is rejected instead of looping forever', async () => {
  const parts = [Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(500_000)]; // > MAX_KV_COUNT
  const p = writeTemp('huge-kv-count.gguf', Buffer.concat(parts));
  const start = Date.now();
  const meta = await gguf.readMeta(p);
  assert.ok(Date.now() - start < 2000, 'must bail out fast, not attempt 500k reads');
  assert.strictEqual(meta.version, 3);
  assert.ok(!('general.architecture' in meta));
});

test('gguf: a pathological array length inside one entry is bounded, not a hang', async () => {
  // key "x", type ARRAY(9), element type UINT8(0), a length far beyond what
  // the (short) buffer actually holds, then nothing — no array data at all
  const entry = Buffer.concat([ggufString('x'), u32(9), u32(0), u64(50_000_000)]);
  const buf = Buffer.concat([Buffer.from('GGUF', 'ascii'), u32(3), u64(0), u64(1), entry]);
  const p = writeTemp('huge-array.gguf', buf);
  const start = Date.now();
  await assert.doesNotReject(() => gguf.readMeta(p));
  assert.ok(Date.now() - start < 2000, 'must bail out fast once the buffer (or step budget) is exhausted');
});

test('gguf: an unreadable/nonexistent path returns {} instead of throwing', async () => {
  assert.deepStrictEqual(await gguf.readMeta(path.join(tmp, 'does-not-exist.gguf')), {});
});

test('quantFromFilename / sizeFromFilename: common on-disk naming conventions', () => {
  assert.strictEqual(gguf.quantFromFilename('Llama-3.2-3B-Instruct-Q4_K_M.gguf'), 'Q4_K_M');
  assert.strictEqual(gguf.quantFromFilename('model.IQ2_XS.gguf'), 'IQ2_XS');
  assert.strictEqual(gguf.quantFromFilename('model-f16.gguf'), 'F16');
  assert.strictEqual(gguf.sizeFromFilename('Llama-3.2-3B-Instruct-Q4_K_M.gguf'), '3B');
  assert.strictEqual(gguf.sizeFromFilename('Mixtral-8x7B-Instruct.gguf'), '8x7B');
});

(async () => {
  let failures = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log(`  ok  ${name}`); }
    catch (e) { failures++; console.error(`FAIL  ${name}\n      ${e.message}`); }
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  if (failures) { console.error(`\n${failures} test(s) failed`); process.exit(1); }
  console.log('\nall llama.cpp adapter tests passed');
})();
