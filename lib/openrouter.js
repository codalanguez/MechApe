/**
 * openrouter.js — optional remote-model backend (OpenRouter).
 *
 * MechApe stays local-first: this module is inert until an API key is
 * configured, and only chats whose model carries the "openrouter:" prefix
 * ever touch it. It mirrors lib/ollama.js's surface (listModels, streamChat)
 * but translates at the boundary so the rest of the app keeps speaking
 * Ollama-shaped NDJSON: OpenRouter streams OpenAI-style SSE
 * (`data: {...choices[0].delta.content}` lines, `:` keepalive comments,
 * a final `data: [DONE]`), which streamChat converts into
 * `{message:{content}}` NDJSON lines via a TransformStream. Routes, the
 * stream tee, and the browser parsers never know the difference.
 */
const { OPENROUTER_KEY, OR_DATA_COLLECTION } = require('./config');
const { sseToNdjson: translateSse } = require('./sse');

const BASE = 'https://openrouter.ai/api/v1';
const PREFIX = 'openrouter:';

/* Attribution headers OpenRouter asks apps to send; the key never leaves
 * this module. */
function headers() {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${OPENROUTER_KEY}`,
    'HTTP-Referer': 'https://github.com/codalanguez/MechApe',
    'X-Title': 'MechApe',
  };
}

const configured = () => Boolean(OPENROUTER_KEY);

/* Finite number or null — the gate every remote-supplied numeric passes
 * before arithmetic or display (typeof alone admits Infinity/NaN). */
const asNum = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/* Remote models are namespaced "openrouter:<vendor/model-id>" everywhere in
 * MechApe (picker values, chat.model on disk) so a stored chat re-opens on the
 * right backend. Ollama names can't collide: their tags never contain "/". */
const isRemote = (name) => typeof name === 'string' && name.startsWith(PREFIX);
const remoteId = (name) => name.slice(PREFIX.length);

/* ---- model catalog (cached 1h — it's a big, slow-moving list) ---- */

let catalog = { at: 0, models: [], failedAt: 0 };

async function listModels() {
  if (Date.now() - catalog.at < 60 * 60 * 1000 && catalog.models.length) return catalog.models;
  // negative cache: while OpenRouter is unreachable, don't re-attempt (and
  // stall callers 15s each) more than once a minute
  if (Date.now() - catalog.failedAt < 60 * 1000) throw new Error('OpenRouter recently unreachable');
  try {
    const r = await fetch(`${BASE}/models`, { headers: headers(), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`OpenRouter models error ${r.status}`);
    const data = await r.json();
    const models = (data.data || []).map(m => ({
      id: m.id,
      name: m.name || m.id,
      contextLength: m.context_length || null,
      // USD per token (strings from the API); the UI turns these into $/M tokens
      promptPrice: m.pricing ? Number(m.pricing.prompt) : null,
      completionPrice: m.pricing ? Number(m.pricing.completion) : null,
    }));
    catalog = { at: Date.now(), models, failedAt: 0 };
    return models;
  } catch (e) {
    catalog.failedAt = Date.now();
    throw e;
  }
}

/** Trained context length for a remote model (from the cached catalog). */
function contextLengthFor(name) {
  const m = catalog.models.find(x => x.id === remoteId(name));
  return (m && m.contextLength) || null;
}

/* ---- options: Ollama semantics → OpenAI/OpenRouter semantics ----
 * OpenRouter accepts a superset of OpenAI sampling params, so most survive.
 * num_ctx has no equivalent (context is fixed per model — never sent), and
 * keep_alive / mirostat* / num_thread and friends are local-runtime knobs. */
function mapOptions(o = {}) {
  const out = {};
  if (o.temperature != null) out.temperature = o.temperature;
  if (o.top_p != null) out.top_p = o.top_p;
  if (o.top_k != null) out.top_k = o.top_k;
  if (o.min_p != null) out.min_p = o.min_p;
  if (o.seed != null) out.seed = o.seed;
  if (o.stop) out.stop = o.stop;
  if (o.num_predict != null && o.num_predict > 0) out.max_tokens = o.num_predict;
  if (o.repeat_penalty != null) out.repetition_penalty = o.repeat_penalty;
  return out;
}

/* Providers with prompt caching that discounts a re-sent system prompt —
 * exactly MechApe's pattern (instructions + attachments resent per message). */
const CACHEABLE = /^(anthropic|google)\//;

/**
 * The full request body for a streaming chat. Exported for tests.
 * - privacy routing: unless the user opted out, only providers that don't
 *   log/train on prompts may serve the request;
 * - usage accounting: the final stream chunk reports tokens + exact cost;
 * - `or_route` ("floor" = cheapest, "nitro" = fastest) becomes the model's
 *   routing-variant suffix (skipped when the id already carries one, e.g. ":free");
 * - the system prompt gets a cache marker on providers that honor it.
 */
function buildChatPayload({ model, messages, options }) {
  const o = options || {};
  let id = remoteId(model);
  if (o.or_route && !id.includes(':')) id = `${id}:${o.or_route}`;

  let msgs = messages;
  if (CACHEABLE.test(id) && msgs.length && msgs[0].role === 'system') {
    msgs = [
      { role: 'system', content: [{ type: 'text', text: msgs[0].content, cache_control: { type: 'ephemeral' } }] },
      ...msgs.slice(1),
    ];
  }

  const payload = { model: id, messages: msgs, stream: true, usage: { include: true }, ...mapOptions(o) };
  if (OR_DATA_COLLECTION === 'deny') payload.provider = { data_collection: 'deny' };
  return payload;
}

/* ---- streaming chat: SSE in, Ollama-shaped NDJSON out ---- */

/* the final chunk carries usage (tokens + exact cost in USD credits). Coerce
 * to numbers at this boundary — these values are persisted and rendered, and
 * must never carry a provider-supplied string. */
function sseToNdjson(body) {
  return translateSse(body, {
    onUsage: (o) => {
      if (!o.usage || o.usage.total_tokens == null) return null;
      return {
        promptTokens: asNum(Number(o.usage.prompt_tokens)) || 0,
        completionTokens: asNum(Number(o.usage.completion_tokens)) || 0,
        cost: asNum(o.usage.cost),
      };
    },
  });
}

/**
 * One non-streaming turn that may come back asking for tools — the remote
 * twin of llamacpp.chatWithTools, same signature and same return, so the
 * tool loop in lib/tools.js does not care which backend answered.
 *
 * Two differences from the local one are worth knowing:
 *
 *   - Tool support varies by underlying model. OpenRouter answers a model
 *     that cannot do it with a 404/400 naming the capability rather than
 *     silently ignoring `tools`. That is turned into a null return, which
 *     the loop reads as "no tools here" and falls through to a plain chat —
 *     a model that cannot call tools should still answer the question.
 *   - `or_route` and privacy routing come along via buildChatPayload, so a
 *     tool turn is routed under the same rules as the streamed one. A
 *     data_collection=deny chat must not quietly relax that just because it
 *     is the tool pre-pass.
 */
async function chatWithTools({ model, messages, tools, options, signal }) {
  const payload = { ...buildChatPayload({ model, messages, options }), stream: false };
  delete payload.usage;                       // no stream, no usage chunk to ask for
  if (tools && tools.length) { payload.tools = tools; payload.tool_choice = 'auto'; }

  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: headers(), body: JSON.stringify(payload), signal,
  });

  if (!r.ok) {
    const text = await r.text().catch(() => '');
    if (looksLikeNoToolSupport(r.status, text)) return null;
    throw new Error(openrouterDetail(text) || `OpenRouter error ${r.status}`);
  }
  const choice = ((await r.json()).choices || [])[0];
  return (choice && choice.message) || { role: 'assistant', content: '' };
}

/* A model that cannot call tools is a routing fact, not a failure: fall back
 * to a normal chat instead of erroring at someone who just asked a question.
 * Matched on the message because OpenRouter's status code for it varies by
 * provider. */
function looksLikeNoToolSupport(status, text) {
  if (status !== 400 && status !== 404 && status !== 422) return false;
  return /tool|function[ _-]?call|not support/i.test(text || '');
}

function openrouterDetail(text) {
  try {
    const e = JSON.parse(text).error;
    return (e && e.message) || '';
  } catch { return text; }
}

/**
 * Open a streaming chat. Returns the same shape routes/pipeNdjson expect from
 * ollama.streamChat: on success {ok, status, body} where body is Ollama-shaped
 * NDJSON; on failure the raw Response (so the caller can read .text()).
 */
async function streamChat({ model, messages, options, signal }) {
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(buildChatPayload({ model, messages, options })),
    signal,
  });
  if (!r.ok) return r;
  return { ok: true, status: r.status, body: sseToNdjson(r.body) };
}

/* ---- account status (for Preferences) ---- */

/* Cached like the catalog: opening Preferences repeatedly shouldn't hammer
 * OpenRouter (or stall 10s offline) — spend figures don't move that fast. */
let keyCache = { at: 0, info: null, failedAt: 0, failedMsg: '' };

/** Key spend + account balance — shown next to where the key is saved.
 * /auth/key gives this key's usage and cap; /credits gives the account's
 * purchased-vs-spent totals, i.e. the real remaining budget. */
async function keyInfo() {
  if (Date.now() - keyCache.at < 60 * 1000 && keyCache.info) return keyCache.info;
  // rethrow the ORIGINAL failure during the cooldown — a rejected key must
  // keep saying "rejected", not degrade into a connectivity message
  if (Date.now() - keyCache.failedAt < 60 * 1000) throw new Error(keyCache.failedMsg || 'OpenRouter recently unreachable');
  try {
    const opts = { headers: headers(), signal: AbortSignal.timeout(10000) };
    const [keyRes, credRes] = await Promise.all([
      fetch(`${BASE}/auth/key`, opts),
      fetch(`${BASE}/credits`, opts).catch(() => null), // balance is optional garnish
    ]);
    if (!keyRes.ok) throw new Error(`OpenRouter key check failed (${keyRes.status})`);
    const d = (await keyRes.json()).data || {};
    // credits stay optional all the way down: a malformed body must not
    // poison the whole key check (or its 60s cache)
    let credits = null;
    try {
      if (credRes && credRes.ok) {
        const c = (await credRes.json()).data || {};
        const totalCredits = asNum(c.total_credits);
        const totalUsage = asNum(c.total_usage);
        if (totalCredits != null && totalUsage != null) {
          credits = { totalCredits, totalUsage, remaining: Math.max(0, totalCredits - totalUsage) };
        }
      }
    } catch { /* garnish failed to parse — the key line still renders */ }
    keyCache = {
      at: Date.now(), failedAt: 0, failedMsg: '',
      info: {
        usage: asNum(d.usage),        // USD spent on this key
        limit: asNum(d.limit),        // USD cap (null = uncapped)
        isFreeTier: Boolean(d.is_free_tier),
        credits,                      // account budget (null if unavailable)
      },
    };
    return keyCache.info;
  } catch (e) {
    keyCache.failedAt = Date.now();
    keyCache.failedMsg = String(e.message || e);
    throw e;
  }
}

module.exports = {
  configured, isRemote, remoteId, listModels, contextLengthFor,
  streamChat, chatWithTools, sseToNdjson, buildChatPayload, keyInfo,
  // exported for tests
  looksLikeNoToolSupport,
};
