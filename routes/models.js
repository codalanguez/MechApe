/**
 * routes/models.js — model endpoints: health, model list, and the streaming
 * chat itself.
 *
 * The chat handler is the heart of the app: it appends the user message,
 * builds the full system prompt (instructions + skills + live attachments),
 * pipes the backend's NDJSON stream straight through to the browser while
 * accumulating the reply server-side, and persists whatever arrived — even
 * if the user hit Stop mid-generation.
 */
const express = require('express');
const { HISTORY_LIMIT, DEFAULT_CONTEXT, EMBED_MODEL_DEFAULT, EMBED_MODEL_SIZE, CHAT_MODEL_DEFAULT, CHAT_MODEL_SIZE } = require('../lib/config');
const { loadProject, saveProject } = require('../lib/store');
const { sanitizeOptions } = require('../lib/options');
const { buildSystem } = require('../lib/prompt');
const { estimateTokens } = require('../lib/tokens');
const { logError } = require('../lib/log');
const { pipeNdjson } = require('../lib/stream');
const llamacpp = require('../lib/llamacpp');
const openrouter = require('../lib/openrouter');
const { embedStatus, isEmbedName, indexStatusFor } = require('../lib/retrieval');
const pkg = require('../package.json');

const router = express.Router();

/* A dropped/reset connection to the chat instance — or an explicit
 * out-of-memory — almost always means the llama-server process crashed,
 * usually because the KV cache for the chosen context length didn't fit the
 * GPU. Translate the raw socket/allocator text into one honest, actionable
 * message. */
// keep RUNNER_CRASH_RE in sync with public/js/chat.js (server catches
// load-time crashes; the client copy catches mid-generation ones).
const RUNNER_CRASH_RE = /wsarecv|forcibly closed|connection reset|econnreset|broken pipe|process (has )?terminated|exit status|unexpected eof|out of memory|cudamalloc|cuda error|insufficient memory|failed to allocate/i;
const looksLikeRunnerCrash = (s) => typeof s === 'string' && RUNNER_CRASH_RE.test(s);

/* Format a context length for a message: 16384 → "16k", 900 → "900". */
const fmtCtx = (n) => (n >= 1024 ? Math.round(n / 1024) + 'k' : String(n));

function runnerCrashMessage(model, ctxN) {
  const ctxNote = ctxN ? ` (context length is ${fmtCtx(ctxN)})` : '';
  return `${model}'s model runner ran out of GPU memory and crashed${ctxNote}. ` +
    `Lower the context length in Model settings, pick a smaller model, or close other GPU apps.`;
}

/* App metadata for the About dialog. `buildDate` is baked into the packaged
 * package.json by scripts/build-info.js; absent in a dev checkout. */
router.get('/about', (req, res) => {
  res.json({
    name: 'MechApe',
    version: pkg.version,
    buildDate: pkg.buildDate || null,
    repo: 'https://github.com/codalanguez/MechApe',
  });
});

router.get('/health', async (req, res) => {
  try {
    const version = await llamacpp.getVersion();
    // accel is null in headless mode (we didn't launch it, so we'd be guessing)
    res.json({ ok: true, version, accel: llamacpp.currentAccel() });
  } catch {
    res.json({ ok: false });
  }
});

router.get('/models', async (req, res) => {
  try {
    res.json({ models: await llamacpp.listModels() });
  } catch {
    res.status(502).json({ error: 'Cannot reach the local model server. Is MechApe\'s llama.cpp backend running?' });
  }
});

/* Rich metadata for one model (for the model info box). */
router.get('/models/info', async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'model name required' });
  try { res.json(await llamacpp.showModel(name)); }
  catch (e) { res.status(502).json({ error: String(e.message || e) || 'model not found' }); }
});

/* Stream a model pull's progress (NDJSON) straight through to the browser.
 * `name` is a "<hf-repo>[:quant]" spec, e.g. "bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M". */
router.post('/models/pull', async (req, res) => {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'a Hugging Face repo (e.g. "owner/repo" or "owner/repo:Q4_K_M") is required' });

  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  let up;
  try { up = await llamacpp.pullModel(name, ac.signal); }
  catch (e) { logError(`model pull "${name}"`, e); return res.status(502).json({ error: String(e.message || e) || 'pull failed' }); }
  if (!up.ok) {
    const t = await up.text().catch(() => '');
    logError(`model pull "${name}"`, t || `status ${up.status}`);
    return res.status(up.status).json({ error: t || `pull failed (${up.status})` });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');
  // a download failure mid-stream arrives as an {error} event inside an
  // otherwise-200 response — log it while still forwarding it to the client.
  try {
    await pipeNdjson(up, res, (o) => { if (o.error) logError(`model pull "${name}"`, o.error); });
  } catch (e) { if (!ac.signal.aborted) logError(`model pull stream "${name}"`, e); }
  res.end();
});

/* Delete a model. Name comes as a query param since it can contain path-ish characters. */
router.delete('/models', async (req, res) => {
  const name = typeof req.query.name === 'string' ? req.query.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'model name required' });
  try { await llamacpp.deleteModel(name); res.json({ ok: true }); }
  catch (e) { logError(`model delete "${name}"`, e); res.status(400).json({ error: String(e.message || e) }); }
});

/* ---- optional remote backend (OpenRouter) ---- */

/* Whether a key is configured — the frontend uses this to show/hide all
 * remote-model UI. The key itself never reaches the browser. */
router.get('/openrouter/status', (req, res) => res.json({ configured: openrouter.configured() }));

/* The remote catalog (id, name, context length, $/token) for the browse
 * dialog. 400 when no key is configured; 502 when OpenRouter is unreachable. */
router.get('/openrouter/models', async (req, res) => {
  if (!openrouter.configured()) return res.status(400).json({ error: 'No OpenRouter API key configured — add one in Preferences.' });
  try { res.json({ models: await openrouter.listModels() }); }
  catch (e) {
    logError('openrouter models', e);
    res.status(502).json({ error: 'Cannot reach OpenRouter — check your internet connection and API key.' });
  }
});

/* Key/credit status for the Preferences panel and browse dialog: USD spent,
 * key cap, and the account's remaining balance. Never returns the key itself. */
router.get('/openrouter/key-status', async (req, res) => {
  if (!openrouter.configured()) return res.status(400).json({ error: 'No OpenRouter API key configured.' });
  try { res.json(await openrouter.keyInfo()); }
  catch (e) {
    logError('openrouter key-status', e);
    const rejected = /\(40[13]\)/.test(String(e.message));
    res.status(502).json({
      error: rejected
        ? 'OpenRouter rejected the API key — check it in Preferences.'
        : 'Could not check the key — is the internet reachable?',
    });
  }
});

/* Friendly copy for remote failures: the status codes carry the meaning. */
function openrouterErrorMessage(status, detail) {
  if (status === 401) return 'OpenRouter rejected the API key — check it in Preferences.';
  if (status === 402) return 'Your OpenRouter account is out of credits — top up at openrouter.ai.';
  if (status === 429) return 'Rate-limited by OpenRouter — wait a moment and try again.';
  return detail || `OpenRouter error ${status}`;
}

/* Whether an embedding model (for large-attachment retrieval) is installed,
 * plus the recommended one to pull if not. */
router.get('/embed-status', async (req, res) => {
  try { res.json(await embedStatus()); }
  catch { res.json({ installed: false, name: null, recommended: EMBED_MODEL_DEFAULT, size: EMBED_MODEL_SIZE }); }
});

/* Whether any chat model (a non-embedding model) is installed, plus the small
 * default to pull if not — so a clean install can start chatting immediately. */
router.get('/chat-status', async (req, res) => {
  try {
    const names = (await llamacpp.listModels()).map(m => m.name);
    res.json({ hasChatModel: names.some(n => !isEmbedName(n)), recommended: CHAT_MODEL_DEFAULT, size: CHAT_MODEL_SIZE });
  } catch { res.json({ hasChatModel: false, recommended: CHAT_MODEL_DEFAULT, size: CHAT_MODEL_SIZE }); }
});

/* Background-indexing progress for a set of attachment paths (for the UI badge).
 * POST because Windows paths don't survive query strings cleanly. */
router.post('/index-status', (req, res) => {
  const paths = Array.isArray(req.body.paths) ? req.body.paths.filter(p => typeof p === 'string').slice(0, 500) : [];
  res.json({ statuses: indexStatusFor(paths) });
});

/* The context limit a request will be compacted against. Local models use the
 * project's num_ctx; remote models have a fixed per-model context length from
 * the OpenRouter catalog (128k fallback while the catalog loads). Without a
 * key, no catalog fetch ever fires — a stale remote chat must not produce
 * outbound traffic from a machine that is supposed to be fully local. */
async function contextLimitFor(model, projectOptions) {
  if (openrouter.isRemote(model)) {
    if (!openrouter.configured()) return 131072;
    if (!openrouter.contextLengthFor(model)) await openrouter.listModels().catch(() => {});
    return openrouter.contextLengthFor(model) || 131072;
  }
  return sanitizeOptions(projectOptions || {}).num_ctx || DEFAULT_CONTEXT;
}

/* Estimated token cost of the fixed part of a request (system prompt +
 * history), plus the context limit, so the composer can warn before overflow.
 * Cheap heuristic — see lib/tokens. */
router.post('/context', async (req, res) => {
  const { projectId, chatId, skillIds = [] } = req.body;
  try {
    const project = loadProject(projectId);
    const chat = project.chats.find(c => c.id === chatId);
    if (!chat) throw new Error('chat not found');
    // use the latest user turn as the retrieval query so the estimate reflects
    // the retrieval-capped size (not a full dump) for big attachments
    const lastUser = [...chat.messages].reverse().find(m => m.role === 'user');
    const system = await buildSystem(project, skillIds, chat, lastUser ? lastUser.content : '');
    const history = chat.messages.slice(-HISTORY_LIMIT).map(m => m.content).join('\n');
    const systemTokens = estimateTokens(system);
    const baseTokens = systemTokens + estimateTokens(history);
    const limit = await contextLimitFor(chat.model || '', project.options);
    // systemTokens is the floor: dropping history can't get a request below it,
    // so the client uses it to tell "compact-able" from "can't compact" overflow
    res.json({ baseTokens, systemTokens, limit });
  } catch (e) { res.status(404).json({ error: String(e.message || e) }); }
});

router.post('/chat', async (req, res) => {
  const { projectId, chatId, message, model, skillIds = [], options = {} } = req.body;
  let project, chat;
  try {
    project = loadProject(projectId);
    chat = project.chats.find(c => c.id === chatId);
    if (!chat) throw new Error('chat not found');
  } catch (e) {
    return res.status(404).json({ error: String(e.message || e) });
  }
  if (!model) return res.status(400).json({ error: 'no model selected' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'empty message' });
  // A remote model without a key must never reach the network: the request
  // would carry the full prompt with an empty Authorization header. Reject it
  // before anything is persisted or sent.
  if (openrouter.isRemote(model) && !openrouter.configured()) {
    return res.status(400).json({
      error: 'This chat uses a remote (OpenRouter) model but no API key is configured — add one in Preferences, or pick a local model.',
    });
  }

  chat.messages.push({ role: 'user', content: message, ts: Date.now(), skillIds });
  if (chat.title === 'New chat') chat.title = message.trim().slice(0, 60);
  chat.model = model;
  saveProject(project);

  const system = await buildSystem(project, skillIds, chat, message);
  const history = chat.messages.slice(-HISTORY_LIMIT).map(m => ({ role: m.role, content: m.content }));

  // Compact to fit the context: drop the oldest history messages until the
  // estimated request fits the limit, always keeping the system prompt and the
  // latest message. (Stored history is untouched — only this request is trimmed.)
  const remote = openrouter.isRemote(model);
  const limit = await contextLimitFor(model, project.options);
  const sysTokens = estimateTokens(system);
  const fits = (msgs) => sysTokens + msgs.reduce((n, m) => n + estimateTokens(m.content), 0) <= limit;
  while (history.length > 1 && !fits(history)) history.shift();

  // Safety net: if even the system prompt + one message can't fit (usually a
  // large attachment), don't hand the backend a doomed request — return a
  // clear, actionable error instead of a cryptic "exceeds context size" one.
  if (!fits(history)) {
    const needK = Math.max(1, Math.round((sysTokens + estimateTokens(history[history.length - 1]?.content || '')) / 1000));
    const advice = remote
      ? 'Pick a remote model with a larger context, or attach less.'
      : 'Raise the context length in Model settings, use a model with a larger context, or attach less.';
    return res.status(413).json({
      error: `This request needs about ${needK}k tokens but the model's context is ${fmtCtx(limit)}. ${advice}`,
    });
  }

  const messages = [{ role: 'system', content: system }, ...history];

  const ac = new AbortController();
  // fires when the client disconnects mid-stream (req 'close' fires too early in modern Node)
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });

  // options come from the project's model settings
  const clean = sanitizeOptions(options);

  let upstream;
  try {
    upstream = remote
      ? await openrouter.streamChat({ model, messages, options: clean, signal: ac.signal })
      : await llamacpp.streamChat({ model, messages, options: clean, signal: ac.signal });
  } catch (e) {
    logError(`chat "${model}" — request failed`, e);
    if (remote) {
      return res.status(502).json({ error: 'Cannot reach OpenRouter — check your internet connection.' });
    }
    // Distinguish "the backend is down" from "the request failed while it was
    // up" — a dropped connection usually means the chat instance crashed,
    // most often out of memory from too high a context length for the GPU.
    let reachable = false;
    try { await llamacpp.getVersion(); reachable = true; } catch { /* really down */ }
    if (reachable) {
      const n = clean.num_ctx;
      const ctxNote = n ? ` (context length is ${fmtCtx(n)})` : '';
      return res.status(502).json({
        error: `${model} failed to respond — the model likely ran out of memory or timed out loading${ctxNote}. ` +
          `Lower the context length in Model settings, or pick a smaller model.`,
      });
    }
    return res.status(502).json({ error: 'Cannot reach the local model server. Is MechApe\'s llama.cpp backend running?' });
  }
  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    let detail = errText;
    // both backends report {error:"..."} or {error:{message}}
    try {
      const parsed = JSON.parse(errText).error;
      detail = (parsed && parsed.message) || parsed || errText;
    } catch { /* raw */ }
    logError(`chat "${model}" — ${remote ? 'OpenRouter' : 'llama.cpp'} ${upstream.status}`, detail);
    if (remote) {
      return res.status(502).json({ error: openrouterErrorMessage(upstream.status, detail) });
    }
    // The instance can die during model load (KV cache won't fit the GPU),
    // surfacing as a 500 with raw socket/allocator text — replace it with a
    // clear cause.
    if (looksLikeRunnerCrash(detail)) {
      return res.status(502).json({ error: runnerCrashMessage(model, clean.num_ctx) });
    }
    return res.status(upstream.status).json({ error: detail || `llama.cpp error ${upstream.status}` });
  }

  res.setHeader('Content-Type', 'application/x-ndjson');
  res.setHeader('Cache-Control', 'no-cache');

  let acc = '';
  let accThink = '';
  let usage = null;
  try {
    await pipeNdjson(upstream, res, (obj) => {
      if (obj.message && obj.message.content) acc += obj.message.content;
      if (obj.message && obj.message.thinking) accThink += obj.message.thinking; // reasoning models
      if (obj.usage) usage = obj.usage; // tokens (+ exact cost, for remote models)
    });
  } catch (e) {
    // client aborting is normal (Stop button); anything else is worth logging
    if (!ac.signal.aborted) logError(`chat "${model}" — stream error`, e);
  }

  if (acc) {
    // reload in case another request touched the project while streaming
    try {
      const fresh = loadProject(projectId);
      const freshChat = fresh.chats.find(c => c.id === chatId);
      if (freshChat) {
        const msg = { role: 'assistant', content: acc, ts: Date.now(), model };
        if (accThink) msg.thinking = accThink;
        if (usage) msg.usage = usage;
        freshChat.messages.push(msg);
        saveProject(fresh);
      }
    } catch { /* project deleted mid-stream */ }
  }
  res.end();
});

module.exports = router;
