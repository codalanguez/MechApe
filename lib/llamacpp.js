/**
 * llamacpp.js — llama.cpp server client + process supervision (chat + embed
 * instances).
 *
 * The only module that talks to the local llama-server processes: health
 * probes, model listing (a plain folder of .gguf files — no registry),
 * pulling one exact file from a Hugging Face repo, and opening a streaming
 * chat. Mirrors the old lib/ollama.js's surface exactly so routes/models.js
 * and lib/retrieval.js don't need to know which backend answered.
 *
 * Two loopback-only server instances, each a fixed role, fixed port for the
 * app's lifetime (see config.js):
 *   LLAMACPP_CHAT_URL  — the currently-selected chat model
 *   LLAMACPP_EMBED_URL — the embedding model
 *
 * In the desktop app, electron/llamacpp.js downloads and SHA256-verifies the
 * llama-server binary once at boot and hands this module its path
 * (LLAMACPP_BIN) — from then on, THIS module spawns and respawns both
 * instances itself, lazily, right before the request that needs them (see
 * "process supervision" below). In headless `npm start`, LLAMACPP_BIN is
 * unset and this module is a pure HTTP client: the user runs both instances
 * themselves at the configured ports (see README).
 */
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn } = require('child_process');
const { LLAMACPP_CHAT_URL, LLAMACPP_EMBED_URL, LLAMACPP_BIN, LLAMACPP_NGL, LLAMACPP_VARIANT, LLAMACPP_DEVICE, MODELS_DIR, DEFAULT_CONTEXT } = require('./config');
const { sseToNdjson } = require('./sse');
const { streamToFile } = require('./download');
const { accelLabel } = require('./accel');
const gguf = require('./gguf');
const { logError, logInfo } = require('./log');

fs.mkdirSync(MODELS_DIR, { recursive: true });

/* ---- process supervision (auto-managed mode only) ----
 *
 * LLAMACPP_BIN is only ever set by the desktop shell, once it has downloaded
 * and SHA256-verified the llama-server binary (electron/llamacpp.js). When
 * it's set, this module spawns/respawns the chat and embed instances itself,
 * lazily, right before the request that needs them — one code path serves
 * both headless `npm start` (LLAMACPP_BIN empty: nothing spawned here, the
 * user runs both instances themselves at the configured ports — see README)
 * and the desktop app (spawned and kept in sync with the selected model).
 *
 * Each instance keeps a fixed port for the app's lifetime (from
 * LLAMACPP_*_URL); only the *process* behind that port changes on a model or
 * context-length change — kill, respawn, wait for /health. */

const AUTO_MANAGED = Boolean(LLAMACPP_BIN);

function portOf(url) { return new URL(url).port; }

const instances = {
  chat: { proc: null, model: null, numCtx: null, url: LLAMACPP_CHAT_URL, role: 'chat' },
  embed: { proc: null, model: null, numCtx: null, url: LLAMACPP_EMBED_URL, role: 'embed' },
};
const respawning = new Map(); // role -> in-flight Promise, so concurrent requests share one respawn

/* Set once a model has failed to load on the GPU and succeeded on CPU — see
 * the fallback in ensureInstance. Session-only on purpose (never persisted),
 * so restarting MechApe gives the GPU another chance. */
let cpuOnly = false;

/**
 * Wait until `url` answers /health, the process dies, or the timeout elapses.
 *
 * Watching the process (not just polling) is what makes a failed model load
 * fail in the ~2s it takes llama-server to die, instead of burning the full
 * 120s timeout — which matters because a load failure is now retried on CPU,
 * and a two-minute stall before that retry would be worse than the crash.
 */
function waitReady(url, proc, timeoutMs) {
  let exitInfo = null;
  const onExit = (code, signal) => { exitInfo = { code, signal }; };
  proc.once('exit', onExit);
  return (async () => {
    const started = Date.now();
    for (;;) {
      if (exitInfo) {
        throw new Error(`llama-server exited while loading the model (${exitInfo.signal || `code ${exitInfo.code}`})`);
      }
      try {
        const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) return;
      } catch { /* not up yet */ }
      if (Date.now() - started > timeoutMs) throw new Error('llama-server did not become healthy in time');
      await new Promise((r) => setTimeout(r, 400));
    }
  })().finally(() => proc.removeListener('exit', onExit));
}

/** Kill a running instance's process and wait for it to actually exit. */
function stopInstance(inst) {
  if (!inst.proc) return Promise.resolve();
  const proc = inst.proc;
  inst.proc = null;
  return new Promise((resolve) => {
    proc.once('exit', () => resolve());
    try { proc.kill(); } catch { resolve(); }
    setTimeout(resolve, 5000); // don't hang forever on a stuck process
  });
}

/**
 * The `-ngl` values to try, in order, for one spawn.
 *
 * Normally "offload to the GPU, and if the model won't load that way, try
 * again on CPU". Once we've already degraded this session there's no second
 * guess left to make — retrying the GPU on every subsequent respawn would
 * just pay the failed-load cost again and again for the same answer.
 */
function planOffloadAttempts(gpuLayers, degraded) {
  if (degraded || gpuLayers === 0) return [0];
  return [gpuLayers, 0];
}

/**
 * Ensure `inst` (the chat or embed role) is running `modelPath` (and, for
 * chat, `numCtx`). No-ops if it already is. Concurrent callers for the same
 * role share one respawn instead of racing separate kill/spawn cycles.
 */
function ensureInstance(inst, modelPath, numCtx) {
  const matches = inst.proc && !inst.proc.killed && inst.model === modelPath
    && (inst.role !== 'chat' || inst.numCtx === numCtx);
  if (matches) return Promise.resolve();

  const key = inst.role;
  if (respawning.has(key)) {
    // A respawn is already in flight — if it's for the same target, ride it;
    // otherwise wait for it to SETTLE (not just succeed — .catch swallows a
    // failure here) before trying again for our own target. Without the
    // .catch, a concurrent respawn for a *different* target that happened to
    // fail would reject this call too, even though our target was never
    // attempted: e.g. request A switches to model X, which times out; request
    // B (wanting model Y, maybe even the one already running) arrives during
    // that window and would otherwise inherit A's unrelated failure instead
    // of getting its own attempt.
    const p = respawning.get(key).catch(() => {}).then(() => ensureInstance(inst, modelPath, numCtx));
    return p;
  }

  const run = (async () => {
    await stopInstance(inst);

    /* Try with GPU offload, then once more on CPU if the model failed to
     * load. This is the safety net under electron/llamacpp.js's boot-time
     * device probe: the probe answers "is there a GPU at all", but a GPU that
     * exists can still fail to load *this* model — most often when the
     * weights plus the KV cache for the chosen context length don't fit in
     * VRAM. Falling back to CPU turns that from a crashed chat into a slow
     * one, which is the better failure.
     *
     * Session-only, deliberately: `cpuOnly` isn't persisted, so a transient
     * shortage (another GPU app was open) doesn't quietly condemn every
     * future launch to CPU. Restarting MechApe tries the GPU again. */
    const gpuLayers = Number(LLAMACPP_NGL) || 0;
    const attempts = planOffloadAttempts(gpuLayers, cpuOnly);
    let lastErr;
    for (let i = 0; i < attempts.length; i++) {
      const isLastAttempt = i === attempts.length - 1;
      try {
        await spawnInstance(inst, modelPath, numCtx, attempts[i]);
        if (attempts[i] === 0 && gpuLayers !== 0 && !cpuOnly) {
          cpuOnly = true;
          logInfo('llama-server fell back to CPU', 'the model would not load on the GPU — generation will be slower for the rest of this session');
        }
        return;
      } catch (e) {
        lastErr = e;
        await stopInstance(inst);
        if (!isLastAttempt) logError(`llama-server (${inst.role}) failed to load on GPU — retrying on CPU`, e);
      }
    }
    throw lastErr;
  })();

  respawning.set(key, run.finally(() => respawning.delete(key)));
  return respawning.get(key);
}

/** One spawn attempt at a given GPU-offload level; resolves once healthy. */
function spawnInstance(inst, modelPath, numCtx, gpuLayers) {
  return (async () => {
    const port = portOf(inst.url);
    const args = [
      '-m', modelPath,
      '--host', '127.0.0.1',
      '--port', port,
      '-ngl', String(gpuLayers),
      '--no-webui',
    ];
    // Pin the offload target when the shell picked one. Skipped on a CPU
    // attempt, where naming a GPU device would be meaningless (and is how
    // the load-failure fallback gets a genuinely different second try).
    if (gpuLayers > 0 && LLAMACPP_DEVICE) args.push('--device', LLAMACPP_DEVICE);
    if (inst.role === 'chat') args.push('-c', String(numCtx));
    else args.push('--embedding', '--pooling', 'mean');

    const proc = spawn(LLAMACPP_BIN, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    inst.proc = proc;
    inst.model = modelPath;
    inst.numCtx = numCtx;
    // Report the PID to the Electron parent (if forked with an IPC channel)
    // so it can be force-killed on quit even if this process dies abruptly and
    // never gets to run its own cleanup — see electron/llamacpp.js. Reported
    // again as null the moment the process exits on its own (a model delete,
    // a re-pull, a crash): without that, the parent would keep a stale PID
    // around indefinitely and could — after the OS eventually recycles that
    // PID for an unrelated process — kill the wrong thing at the next quit.
    const reportPid = (pid) => {
      if (typeof process.send !== 'function') return;
      try { process.send({ type: 'llamacpp:pid', role: inst.role, pid }); } catch { /* no IPC channel */ }
    };
    reportPid(proc.pid);
    let stderrTail = '';
    proc.stderr?.on('data', (d) => { stderrTail = (stderrTail + d.toString()).slice(-4000); });
    proc.on('exit', (code) => {
      if (inst.proc === proc) { inst.proc = null; reportPid(null); }
      if (code) logError(`llama-server (${inst.role}) exited`, `code ${code}\n${stderrTail}`);
    });
    proc.on('error', (e) => logError(`llama-server (${inst.role}) failed to start`, e));

    // model load can be slow, especially cold — but a process that dies
    // trying rejects immediately rather than sitting out the full timeout
    await waitReady(inst.url, proc, 120000);
    logInfo(
      `llama-server (${inst.role}) ready`,
      `${path.basename(modelPath)} on ${inst.url} (${gpuLayers === 0 ? 'CPU' : `${gpuLayers} GPU layers`})`,
    );
  })();
}

/** Best-effort cleanup on a graceful process exit (headless `npm start`,
 * Ctrl+C). The desktop-quit path is covered separately by the PID report
 * above, since an abrupt parent-initiated kill on Windows doesn't give this
 * process a chance to run handlers like this one. */
function stopAll() { for (const inst of Object.values(instances)) { try { inst.proc?.kill(); } catch { /* already gone */ } } }
if (AUTO_MANAGED) {
  process.on('exit', stopAll);
  process.on('SIGINT', () => { stopAll(); process.exit(); });
  process.on('SIGTERM', () => { stopAll(); process.exit(); });
}

/* ---- model catalog: a folder of .gguf files, not a registry ---- */

async function listFiles() {
  let names;
  try { names = await fsp.readdir(MODELS_DIR); } catch { return []; }
  return names.filter(n => n.toLowerCase().endsWith('.gguf'));
}

/* This endpoint is polled from several places (the model picker, chat-status,
 * embed-status, the model manager modal) — async + parallel stats keep the
 * event loop free during what's effectively a status poll, instead of a
 * sequence of blocking sync stat() calls one file at a time. */
async function listModels() {
  const names = await listFiles();
  return Promise.all(names.map(async (name) => {
    let size = 0;
    try { size = (await fsp.stat(path.join(MODELS_DIR, name))).size; } catch { /* raced a delete */ }
    return { name, size };
  }));
}

/* name -> absolute path inside MODELS_DIR, or null. Rejects anything that
 * isn't a bare *.gguf filename directly inside the folder — no separators,
 * no "..", no ":" (blocks Windows NTFS alternate-data-stream syntax like
 * "model.gguf:hidden", which a bare-filename check alone doesn't catch,
 * since path.dirname() parses on "\" and never sees the ":"), and a
 * belt-and-suspenders resolved-parent check. Requiring the .gguf suffix here
 * (not just on write, via safeGgufName) means these endpoints can only ever
 * touch actual model files, never an arbitrary bystander file that happens
 * to sit in the same folder. The one gate between a client-supplied model
 * name and a filesystem read/delete. */
function resolveModelPath(name) {
  if (typeof name !== 'string' || !name) return null;
  if (/[\\/:]|\.\./.test(name) || !/\.gguf$/i.test(name)) return null;
  const root = path.resolve(MODELS_DIR);
  const p = path.join(root, name);
  if (path.dirname(p) !== root) return null;
  return p;
}

async function showModel(name) {
  const p = resolveModelPath(name);
  if (!p || !fs.existsSync(p)) throw new Error('model not found');
  const info = await gguf.describeModel(p, name);
  return {
    name,
    parameterSize: info.parameterSize,
    quantization: info.quantization,
    contextLength: info.contextLength,
    capabilities: info.capabilities,
  };
}

/* ---- health ---- */

/**
 * Is the local backend available?
 *
 * "Available" means *able to serve a chat*, which is not the same as "a
 * server is listening right now". In auto-managed mode instances are spawned
 * on demand — so between launch and your first message there is deliberately
 * nothing on the chat port, and probing it would report the backend as down
 * while it is perfectly healthy. (That read as a hard failure in the UI: with
 * no model installed you can't send the message that would start the
 * instance, so the status pill sat on "unreachable" forever.) What actually
 * matters here is whether we hold a verified binary to spawn.
 *
 * Headless mode is the opposite: nothing spawns instances for us, so an
 * actual HTTP probe is the only meaningful signal.
 */
async function getVersion() {
  if (AUTO_MANAGED) {
    if (!fs.existsSync(LLAMACPP_BIN)) throw new Error('the llama.cpp binary is missing');
    return 'llama.cpp';
  }
  const r = await fetch(`${LLAMACPP_CHAT_URL}/health`, { signal: AbortSignal.timeout(2500) });
  if (!r.ok) throw new Error(`llama.cpp health check failed (${r.status})`);
  return 'llama.cpp'; // no single version string the way Ollama reports one
}

/**
 * What generation is actually running on: 'CUDA' | 'Vulkan' | 'Metal' | 'CPU',
 * or null when MechApe isn't managing the backend (headless `npm start` — the
 * user launched llama-server themselves and we'd only be guessing).
 *
 * Surfaced in the status pill so a fallback to CPU is *visible*. A silent
 * downgrade would just look like "why did this get slow", which is exactly
 * the kind of quiet dishonesty the rest of the app avoids.
 */
function currentAccel() {
  if (!AUTO_MANAGED) return null;
  return cpuOnly ? 'CPU' : accelLabel(LLAMACPP_VARIANT);
}

/* ---- options: Ollama-shaped -> llama-server's extended OpenAI body ----
 * num_ctx is deliberately NOT sent here — llama-server takes context length
 * as a launch flag (-c), not a per-request option, so a context-length
 * change in Model Settings triggers a chat-instance respawn (same place a
 * model change already does — see electron/llamacpp.js). */
function mapOptions(o = {}) {
  const out = {};
  if (o.temperature != null) out.temperature = o.temperature;
  if (o.top_p != null) out.top_p = o.top_p;
  if (o.top_k != null) out.top_k = o.top_k;
  if (o.min_p != null) out.min_p = o.min_p;
  if (o.seed != null) out.seed = o.seed;
  if (o.stop) out.stop = o.stop;
  if (o.num_predict != null && o.num_predict > 0) out.max_tokens = o.num_predict;
  if (o.repeat_penalty != null) out.repeat_penalty = o.repeat_penalty;
  if (o.repeat_last_n != null) out.repeat_last_n = o.repeat_last_n;
  if (o.mirostat != null) out.mirostat = o.mirostat;
  if (o.mirostat_eta != null) out.mirostat_eta = o.mirostat_eta;
  if (o.mirostat_tau != null) out.mirostat_tau = o.mirostat_tau;
  return out;
}

/* ---- chat ---- */

/** In auto-managed (desktop) mode, make sure the chat instance is running
 * this exact model + context length before the request — a no-op if it
 * already is. In headless mode (LLAMACPP_BIN unset) this is a no-op; the
 * user is responsible for running the instance themselves. */
async function ensureChatModel(model, numCtx) {
  if (!AUTO_MANAGED) return;
  const p = resolveModelPath(model);
  if (!p || !fs.existsSync(p)) throw new Error(`model "${model}" not found in the models folder`);
  // chatOnce (skill generation) doesn't carry a project's context-length
  // setting and calls this with numCtx=null. If that model is already the
  // one running, keep its current context instead of forcing DEFAULT_CONTEXT
  // — otherwise every "Create with model" call on the model you're already
  // chatting with would respawn it down to 4096, then respawn it back up
  // again on your very next message.
  const ctx = numCtx || (instances.chat.model === p ? instances.chat.numCtx : null) || DEFAULT_CONTEXT;
  await ensureInstance(instances.chat, p, ctx);
}

/* No keep_alive knob: unlike Ollama, there's nothing to configure — the
 * model stays loaded for as long as the chat instance process runs. */
async function streamChat({ model, messages, options, signal }) {
  await ensureChatModel(model, (options || {}).num_ctx);
  const payload = { model, messages, stream: true, ...mapOptions(options) };
  return fetch(`${LLAMACPP_CHAT_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  }).then(r => (r.ok ? { ok: true, status: r.status, body: sseToNdjson(r.body) } : r));
}

async function chatOnce({ model, messages, timeoutMs = 180000 }) {
  await ensureChatModel(model, null);
  const r = await fetch(`${LLAMACPP_CHAT_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = ((await r.json()).error || {}).message || ''; } catch { /* raw */ }
    throw new Error(detail || `llama.cpp error ${r.status}`);
  }
  const data = await r.json();
  const choice = data.choices && data.choices[0];
  return (choice && choice.message && choice.message.content) || '';
}

/* ---- embeddings ---- */

/** Mirrors ensureChatModel for the embed instance (no context-length knob —
 * embedding models don't take a chat-style context window here). */
async function ensureEmbedModel(model) {
  if (!AUTO_MANAGED) return;
  const p = resolveModelPath(model);
  if (!p || !fs.existsSync(p)) throw new Error(`embedding model "${model}" not found in the models folder`);
  await ensureInstance(instances.embed, p, null);
}

async function embed(model, input, { signal, timeoutMs = 120000 } = {}) {
  await ensureEmbedModel(model);
  const r = await fetch(`${LLAMACPP_EMBED_URL}/v1/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, input }),
    signal: signal || AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    let detail = '';
    try { detail = ((await r.json()).error || {}).message || ''; } catch { /* raw */ }
    throw new Error(detail || `llama.cpp embed error ${r.status}`);
  }
  const data = await r.json();
  // OpenAI-shaped: {data:[{index, embedding:[...]}]} — order by index, not
  // arrival order (batched requests aren't guaranteed to return in order).
  const rows = Array.isArray(data.data) ? [...data.data].sort((a, b) => (a.index || 0) - (b.index || 0)) : [];
  return rows.map(d => (Array.isArray(d.embedding) ? d.embedding : []));
}

/* ---- pull: download one exact .gguf file from a Hugging Face repo ----
 * No registry, no third-party resolver shelled out to — MechApe makes the
 * network call itself, so it's exactly one HTTPS request to a pinned host
 * before the download, fully visible to anyone reading this file. */

const HF_API = 'https://huggingface.co/api/models';
const HF_HOST = 'huggingface.co';
const DEFAULT_QUANT = 'Q4_K_M';
const MAX_DOWNLOAD_BYTES = 64 * 1024 * 1024 * 1024; // sanity cap, not a real limit on legitimate weights

/** "<repo>:<quant>" -> {repo, quant}. A bare repo id defaults to Q4_K_M
 * (mirrors llama.cpp's own -hf flag fallback). The split is on the LAST ":"
 * and only if it comes after the repo's "/", so a repo id can't be
 * misparsed by an embedded colon. */
function parseSpec(spec) {
  const s = String(spec || '').trim();
  const slash = s.indexOf('/');
  const colon = s.lastIndexOf(':');
  if (colon === -1 || colon < slash) return { repo: s, quant: DEFAULT_QUANT };
  return { repo: s.slice(0, colon), quant: (s.slice(colon + 1).trim().toUpperCase() || DEFAULT_QUANT) };
}

/** Bare filename only: must end in .gguf, no path separators or "..", and
 * survive path.basename unchanged. This is what stands between a Hugging
 * Face repo listing (untrusted, if the repo itself were malicious) and a
 * filesystem write — no filename it returns can escape MODELS_DIR. */
function safeGgufName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || /\.\./.test(base) || !/^[\w.\-+]+\.gguf$/i.test(base)) return null;
  return base;
}

async function resolveHfFile(repo, quant, signal) {
  if (!/^[\w.\-]+\/[\w.\-]+$/.test(repo)) throw new Error(`"${repo}" doesn't look like a Hugging Face repo id (expected owner/name)`);
  const r = await fetch(`${HF_API}/${repo}`, {
    headers: { 'User-Agent': 'MechApe/1.0 (+https://github.com/codalanguez/MechApe)' },
    signal: signal || AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error(r.status === 404 ? `Repo "${repo}" not found on Hugging Face` : `Hugging Face lookup failed (${r.status})`);
  const data = await r.json();
  const files = (Array.isArray(data.siblings) ? data.siblings : [])
    .map(s => s.rfilename).filter(n => typeof n === 'string' && n.toLowerCase().endsWith('.gguf'));
  if (!files.length) throw new Error(`"${repo}" has no .gguf files`);
  const match = files.find(n => n.toUpperCase().includes(quant)) || files[0];
  const safe = safeGgufName(path.basename(match));
  if (!safe) throw new Error('repo listing returned an unsafe filename');
  return safe;
}

/** Wraps lib/download.js's streamToFile to emit {status,total,completed}
 * NDJSON progress lines — the exact shape public/js/model-manager.js already
 * parses — instead of returning a bare promise. */
function downloadWithProgress(sourceBody, dest, total) {
  const encoder = new TextEncoder();
  return new ReadableStream({
    async start(controller) {
      const emit = (o) => controller.enqueue(encoder.encode(JSON.stringify(o) + '\n'));
      try {
        let completed = 0;
        await streamToFile(sourceBody, dest, {
          total,
          maxBytes: MAX_DOWNLOAD_BYTES,
          onProgress: (done, tot) => { completed = done; emit({ status: 'downloading', total: tot, completed: done }); },
          // Windows locks an in-use file — stop whichever instance has this
          // exact path loaded (re-pulling an already-installed model) before
          // the rename, or it fails with EPERM/EBUSY.
          beforeRename: async () => {
            for (const inst of Object.values(instances)) {
              if (inst.model === dest) await stopInstance(inst);
            }
          },
        });
        emit({ status: 'done', total, completed });
      } catch (e) {
        emit({ error: String(e.message || e) });
      } finally {
        controller.close();
      }
    },
  });
}

/**
 * Resolve `spec` ("<hf-repo>[:quant]") to one file and download it. Returns
 * a fetch-Response-shaped object ({ok, status, body}) so routes/models.js's
 * existing pull-and-pipe handling (built for a raw fetch Response) works
 * unchanged: `body` is NDJSON progress on success, and a plain failed
 * Response (with .text()) if the download request itself never started.
 */
async function pullModel(spec, signal) {
  const { repo, quant } = parseSpec(spec);
  const file = await resolveHfFile(repo, quant, signal); // throws with a descriptive, user-facing message
  const dest = resolveModelPath(file);
  if (!dest) throw new Error('resolved filename is unsafe');
  const url = `https://${HF_HOST}/${repo}/resolve/main/${encodeURIComponent(file)}`;
  const r = await fetch(url, { signal, redirect: 'follow' });
  if (!r.ok || !r.body) return r;
  const total = Number(r.headers.get('content-length')) || 0;
  if (total > MAX_DOWNLOAD_BYTES) throw new Error('file is larger than the safety size cap');
  return { ok: true, status: 200, body: downloadWithProgress(r.body, dest, total) };
}

async function deleteModel(name) {
  const p = resolveModelPath(name);
  if (!p) throw new Error('invalid model name');
  // Windows holds an exclusive lock on a file a running process has open —
  // deleting a model currently loaded by either instance would otherwise
  // fail with EPERM/EBUSY. Stop whichever instance is using it first.
  for (const inst of Object.values(instances)) {
    if (inst.model === p) await stopInstance(inst);
  }
  try { fs.unlinkSync(p); } catch (e) { throw new Error(e.code === 'ENOENT' ? 'model not found' : String(e.message || e)); }
  return true;
}

module.exports = {
  getVersion, currentAccel, listModels, showModel, streamChat, chatOnce, embed,
  pullModel, deleteModel,
  // exported for tests only — pure helpers with no network/process side effects
  mapOptions, parseSpec, safeGgufName, resolveModelPath, planOffloadAttempts,
};
