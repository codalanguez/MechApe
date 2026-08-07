/**
 * config.js — central configuration.
 *
 * Every tunable in the app lives here: ports, directory locations, context
 * budgets, and feature switches, all read once from environment variables.
 * Other modules import from this file instead of touching process.env, so
 * there is a single place to see (and change) how MechApe is configured.
 */
const path = require('path');

/* Read a MECHAPE_* setting, falling back to the MONKII_* name the app used
 * before the rename. Costs one lookup and means an existing shell profile,
 * launcher, or CI job doesn't silently start ignoring a configured data
 * directory the moment the product changed name — the failure mode there is
 * an app that looks empty rather than one that errors, which is the worst
 * kind. Drop the fallback once nothing in the wild sets the old names. */
function env(name) {
  const v = process.env[`MECHAPE_${name}`];
  return v !== undefined ? v : process.env[`MONKII_${name}`];
}

/* The two local llama.cpp server instances MechApe supervises (see
 * electron/llamacpp.js) — always loopback, never derived from an ambient
 * "host" value the way Ollama's OLLAMA_HOST used to be. There's nothing to
 * normalize: unlike a system daemon, these ports are MechApe's own choice
 * (fixed defaults for a headless `npm start` backend the user starts by
 * hand; the desktop app picks free ports itself and forwards them here). */
function localUrl(name, defaultPort) {
  const raw = (env(name) || '').trim();
  if (!raw) return `http://127.0.0.1:${defaultPort}`;
  try {
    const u = new URL(raw);
    // never let a misconfigured env var point this at a non-loopback host —
    // these calls are never meant to leave the machine
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return `http://127.0.0.1:${defaultPort}`;
    return u.origin;
  } catch { return `http://127.0.0.1:${defaultPort}`; }
}

const ROOT = path.join(__dirname, '..');

module.exports = {
  ROOT,
  PORT: process.env.PORT || 8113,
  LLAMACPP_CHAT_URL: localUrl('LLAMACPP_CHAT_URL', 8114),
  LLAMACPP_EMBED_URL: localUrl('LLAMACPP_EMBED_URL', 8115),
  /* Path to the llama-server executable. Only ever set by the desktop shell
   * once it has downloaded and SHA256-verified it (see electron/llamacpp.js)
   * — its presence is what turns on auto-spawn/respawn in lib/llamacpp.js.
   * Empty in headless `npm start`: the user starts both instances themselves
   * (see README), and lib/llamacpp.js stays a pure HTTP client. */
  LLAMACPP_BIN: env('LLAMACPP_BIN') || '',
  LLAMACPP_NGL: env('LLAMACPP_NGL') || '999', // GPU layers to offload; harmless on CPU-only builds
  /* Which build the shell picked ('cuda' | 'vulkan' | 'metal' | 'cpu') — set
   * alongside LLAMACPP_BIN, and reported in /api/health so the UI can say
   * what generation is actually running on. */
  LLAMACPP_VARIANT: env('LLAMACPP_VARIANT') || '',
  /* Which enumerated device to offload to, e.g. "Vulkan1". Chosen by the
   * shell's probe (see lib/accel.js pickDevice); empty means "let llama.cpp
   * decide", which is right for CPU builds and single-GPU machines. */
  LLAMACPP_DEVICE: env('LLAMACPP_DEVICE') || '',

  /* storage locations — the desktop app points DATA_DIR at the per-user
   * appdata folder so installed-app updates never touch project data */
  DATA_DIR: env('DATA_DIR') || path.join(ROOT, 'data', 'projects'),
  LOG_DIR: env('LOG_DIR') || path.join(ROOT, 'logs'),
  SKILLS_DIR: env('SKILLS_DIR') || path.join(ROOT, 'skills'),
  MODELS_DIR: env('MODELS_DIR') || path.join(ROOT_DATA(), 'models'),

  /* optional filesystem allowlist: "C:\projects;D:\writing" restricts browsing
   * AND attachment reads to those trees. Empty = whole disk (single-user default). */
  FS_ROOTS: (env('FS_ROOTS') || '')
    .split(';').map(s => s.trim()).filter(Boolean).map(p => path.resolve(p)),

  /* optional remote backend (OpenRouter). Empty = fully local, the default.
   * The desktop shell injects this from the encrypted key saved in Preferences;
   * browser mode can set it directly. Chats only go remote when their model
   * carries the "openrouter:" prefix — never implicitly. */
  OPENROUTER_KEY: (env('OPENROUTER_KEY') || '').trim(),

  /* remote privacy routing: 'deny' (default) restricts remote chats to
   * providers that don't log or train on prompts; 'allow' widens provider
   * choice. Toggle in Preferences → Remote models. */
  OR_DATA_COLLECTION: (env('OR_DATA_COLLECTION') || 'deny').toLowerCase() === 'allow' ? 'allow' : 'deny',

  /* context budgets (bytes of text pulled from disk per request) */
  FILE_LIMIT: 120 * 1024,      // per attached file
  DIR_FILE_LIMIT: 48 * 1024,   // per file inside an attached directory
  DIR_MAX_FILES: 60,           // files per attached directory
  TOTAL_BUDGET: 480 * 1024,    // all attachments combined
  SKILL_LIMIT: 64 * 1024,      // per skill body injected into the prompt
  HISTORY_LIMIT: 40,           // messages of chat history sent to the model
  DEFAULT_CONTEXT: 4096,       // assumed num_ctx when the model settings leave it unset

  /* skill import safety caps — skills are text; anything bigger is a mistake */
  IMPORT_MAX_FILES: 400,
  IMPORT_MAX_BYTES: 20 * 1024 * 1024,

  /* file preview + write-to-disk ("Save as file…") */
  PREVIEW_MAX_BYTES: 2 * 1024 * 1024,  // preview reads at most this much of a file
  // WRITE_MAX_BYTES caps the DECODED content, but the wire body the global
  // 4mb JSON parser (server.js) sees is JSON-escaped — newlines/quotes/
  // backslashes each double in size, so newline-heavy text (a real, plausible
  // save, not just an adversarial one — measured: 2.9mb of blank lines
  // encoded to 5.8mb on the wire) can silently exceed the parser's cap even
  // while under this one, and fail with a generic error instead of this
  // route's friendly message. 1.5mb keeps even that 2x worst realistic case
  // (3mb) safely under the 4mb ceiling; "save this chat message" doesn't
  // need more room than that (large content belongs in an attachment).
  WRITE_MAX_BYTES: 1.5 * 1024 * 1024,

  /* ---- local retrieval (RAG over big attachments) ----
   * A large attachment is embedded once (chunk-by-chunk, on-device via the
   * embed llama-server instance) and only the passages most relevant to the
   * question are injected — instead of dumping the whole thing into every
   * prompt. Entirely offline. */
  RETRIEVAL: (env('RETRIEVAL') || 'on').toLowerCase() !== 'off',
  EMBED_MODEL: env('EMBED_MODEL') || '', // '' = auto-pick an installed .gguf embed model
  // recommended first-run pulls, as "<hf-repo>:<quant>" specs (see lib/llamacpp.js pullModel)
  EMBED_MODEL_DEFAULT: env('EMBED_MODEL') || 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q4_K_M',
  EMBED_MODEL_SIZE: '~84 MB',
  CHAT_MODEL_DEFAULT: env('CHAT_MODEL') || 'bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M',
  CHAT_MODEL_SIZE: '~2 GB',
  EMBED_DIR: env('EMBED_DIR') || path.join(ROOT_DATA(), 'embeddings'),
  RETRIEVAL_MIN_CHARS: 64 * 1024,   // dump attachments smaller than this; retrieve when larger
  RETRIEVAL_BUDGET: 24 * 1024,      // chars of retrieved passages injected per big attachment
  RETRIEVAL_TOPK: 12,               // most passages to inject
  CHUNK_CHARS: 1200,                // target chunk size for embedding
  CHUNK_OVERLAP: 200,               // overlap between adjacent chunks
  /* Batch/context size for the embed llama-server, in tokens.
   *
   * With --pooling mean a whole chunk has to fit inside one *physical* batch,
   * and llama.cpp's default ubatch is 512. A chunk is capped at CHUNK_CHARS
   * (1200) characters, which is comfortably under 512 tokens for ordinary
   * prose but not for dense text — a markdown inventory of file paths and
   * numbers measured 517 tokens and failed outright with "input is too large
   * to process". Retrieval then fell back to dumping the file, silently,
   * exactly for the token-dense content it helps most with.
   *
   * 2048 covers 1200 characters even at a pathological ~1.7 tokens per
   * character, well past what any real tokenizer produces. Clamped at spawn
   * to what the model actually supports (see spawnInstance). */
  EMBED_BATCH: Number(env('EMBED_BATCH')) > 0 ? Number(env('EMBED_BATCH')) : 2048,

  /* ---- MCP integrations (tools the model can call) ----
   * Claude Desktop's config format, so a server already configured there
   * pastes across unedited. Absent file = no integrations, which is the
   * default: MechApe ships no servers and installs none. */
  MCP_CONFIG: env('MCP_CONFIG') || path.join(ROOT_DATA(), 'mcp.json'),
  MCP_STARTUP_TIMEOUT: 20000,       // handshake + tools/list; npx may fetch a package first
  MCP_CALL_TIMEOUT: 60000,          // one tools/call
  MCP_MAX_TOOL_ROUNDS: 5,           // tool -> model -> tool cycles before answering anyway

  /* ---- cross-chat memory ----
   * Durable facts about the user, carried between chats. Plain sentences in
   * a plain file, readable and deletable through /api/memory — see
   * lib/memory.js for why that matters more than the feature does.
   * MECHAPE_MEMORY=off disables extraction and injection entirely. */
  MEMORY_ENABLED: (env('MEMORY') || 'on').toLowerCase() !== 'off',
  MEMORY_FILE: env('MEMORY_FILE') || path.join(ROOT_DATA(), 'memory.json'),
  MEMORY_MAX: 200,                  // facts kept; oldest drop out past this
  MEMORY_INJECT: 8,                 // most relevant facts put into a prompt
  MAX_CHUNKS: 4000,                 // cap embedding work for pathological inputs
  INDEX_FILE_MAX: 3 * 1024 * 1024,  // bytes read from a single big file for indexing
  INDEX_DIR_FILE_MAX: 128 * 1024,   // bytes read per file inside a big directory for indexing
  EMBED_CACHE_MAX: 512 * 1024 * 1024, // cap on the on-disk index dir; oldest-used evicted past this
};

/* embeddings and downloaded models live beside the projects data
 * (…/MechApe/embeddings, …/MechApe/models), derived from wherever DATA_DIR
 * points so a custom data location keeps them together. */
function ROOT_DATA() {
  const dataDir = env('DATA_DIR') || path.join(ROOT, 'data', 'projects');
  return path.dirname(dataDir);
}
