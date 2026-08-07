/**
 * retrieval.js — on-device semantic retrieval over large attachments.
 *
 * A big attachment (a whole manuscript, a codebase) is chunked, embedded once
 * with the local embed llama-server instance, and the index is cached on disk keyed by
 * the file's path + size + mtime. At query time we embed just the question and
 * return the handful of passages most similar to it — so the prompt carries the
 * relevant parts instead of the entire file. Everything runs offline.
 *
 * Design notes:
 *  - One index *pair* per source path: a `.json` file (chunk TEXT + metadata,
 *    cleartext, gitignored under EMBED_DIR) and a sibling `.bin` file holding
 *    the vectors as raw Float32 — JSON-encoding floats as decimal text runs
 *    ~10x larger than the binary, and this is almost all of an index's bytes.
 *    A size/mtime change rebuilds the pair. (A rare content-preserving edit
 *    that keeps the exact byte size *and* mtime would serve a stale index —
 *    acceptable vs. hashing the whole file every message.) A `.json` from the
 *    pre-binary format (no `dims`, or a missing `.bin`) just misses the cache
 *    and rebuilds — no explicit migration needed.
 *  - It is pruned: dropped when the attachment is removed, and the dir is
 *    capped (EMBED_CACHE_MAX) with least-recently-used eviction.
 *  - Failure is never fatal: if no embed model is installed or embedding errors,
 *    the caller falls back to dumping the file as before.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  EMBED_MODEL, EMBED_MODEL_DEFAULT, EMBED_MODEL_SIZE, EMBED_DIR, EMBED_CACHE_MAX,
  CHUNK_CHARS, CHUNK_OVERLAP, MAX_CHUNKS, RETRIEVAL_TOPK,
} = require('./config');
const llamacpp = require('./llamacpp');
const { logError } = require('./log');

const EMBED_BATCH = 48;             // chunks per /v1/embeddings request
const KNOWN_EMBED = ['nomic-embed-text', 'mxbai-embed', 'all-minilm', 'bge-', 'snowflake-arctic-embed', 'gte-', 'embed'];

/* Single source of truth for "is this an embedding model?" — shared by the
 * picker, the status check, and the benchmark script. Filename heuristics
 * first (cheap, no disk read); a GGUF file whose name doesn't match still
 * gets caught by its own pooling-type metadata in lib/gguf.js. */
const isEmbedName = (n) => KNOWN_EMBED.some(k => n.toLowerCase().includes(k));
const norm = (n) => n.toLowerCase().replace(/\.gguf$/i, '');

/* Resolve the embed model to use from the installed list: an explicit
 * MECHAPE_EMBED_MODEL only if it's actually installed, else the first embed
 * model found. Returns null if none — so a misconfigured EMBED_MODEL doesn't
 * send the retrieval path chasing a model that isn't installed. */
function resolveEmbed(names) {
  if (EMBED_MODEL) return names.find(n => norm(n) === norm(EMBED_MODEL)) || null;
  return names.find(isEmbedName) || null;
}

let embedModelCache = { at: 0, name: null };

/** Auto-pick an installed embedding model (cached 60s). Null if none installed. */
async function pickEmbedModel() {
  if (Date.now() - embedModelCache.at < 60000) return embedModelCache.name;
  let name = null;
  try { name = resolveEmbed((await llamacpp.listModels()).map(m => m.name)); }
  catch { /* embed instance unreachable — leave null, caller dumps instead */ }
  embedModelCache = { at: Date.now(), name };
  return name;
}

/** Is an embedding model installed? Returns { installed, name, recommended, size }. */
async function embedStatus() {
  let names = [];
  try { names = (await llamacpp.listModels()).map(m => m.name); } catch { /* backend down */ }
  const name = resolveEmbed(names);
  return { installed: !!name, name, recommended: EMBED_MODEL_DEFAULT, size: EMBED_MODEL_SIZE };
}

/* nomic-style embedding models want task prefixes; harmless to skip elsewhere. */
const isNomic = (model) => /nomic/i.test(model);
const asDoc = (model, t) => (isNomic(model) ? `search_document: ${t}` : t);
const asQuery = (model, t) => (isNomic(model) ? `search_query: ${t}` : t);

/** Split text into overlapping chunks, preferring paragraph boundaries. */
function chunkText(text) {
  const chunks = [];
  const n = text.length;
  let i = 0;
  while (i < n && chunks.length < MAX_CHUNKS) {
    let end = Math.min(i + CHUNK_CHARS, n);
    if (end < n) {
      // back up to the nearest paragraph/line/sentence break for a cleaner cut
      const slice = text.slice(i, end);
      const brk = Math.max(slice.lastIndexOf('\n\n'), slice.lastIndexOf('\n'), slice.lastIndexOf('. '));
      if (brk > CHUNK_CHARS * 0.5) end = i + brk + 1;
    }
    const piece = text.slice(i, end).trim();
    if (piece) chunks.push({ text: piece, offset: i });
    if (end >= n) break;
    i = Math.max(end - CHUNK_OVERLAP, i + 1);
  }
  return chunks;
}

function ensureDir() {
  try { fs.mkdirSync(EMBED_DIR, { recursive: true }); } catch { /* best effort */ }
}
const indexFile = (key) => path.join(EMBED_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
const vectorFile = (jsonFile) => jsonFile.replace(/\.json$/, '.bin');

/* Live build progress per source path, so the UI can show an "indexing %"
 * badge while a big attachment embeds in the background. */
const indexProgress = new Map(); // sourcePath -> { state:'building'|'ready'|'error', done, total }
const dropped = new Set();       // keys dropped mid-build (see loadOrBuildIndex)

const pct = (s) => (s.total ? Math.round(100 * s.done / s.total) : (s.state === 'ready' ? 100 : 0));

/** Progress for the given source paths. A directory attachment's status rolls up
 * its member files (each is indexed separately); unknown/small paths are 'idle'. */
function indexStatusFor(paths) {
  const out = {};
  for (const p of paths) {
    const s = indexProgress.get(p);
    if (s) { out[p] = { state: s.state, pct: pct(s) }; continue; }
    // maybe a directory attachment — aggregate any member-file progress under it
    const prefix = p.endsWith(path.sep) ? p : p + path.sep;
    let done = 0, total = 0, building = false, any = false;
    for (const [k, v] of indexProgress) {
      if (!k.startsWith(prefix)) continue;
      any = true; done += v.done; total += v.total;
      if (v.state === 'building') building = true;
    }
    out[p] = any ? { state: building ? 'building' : 'ready', pct: pct({ done, total, state: building ? 'building' : 'ready' }) }
                 : { state: 'idle', pct: 0 };
  }
  return out;
}

/** Delete the on-disk index for a source path (e.g. when its attachment is removed). */
function dropIndex(sourcePath) {
  dropped.add(sourcePath); // catch a build that's in flight right now
  const file = indexFile(sourcePath);
  try { fs.unlinkSync(file); } catch { /* not indexed / already gone */ }
  try { fs.unlinkSync(vectorFile(file)); } catch { /* no vectors (empty index) / already gone */ }
  indexProgress.delete(sourcePath);
}

/** Drop every currently-tracked source path at once — for a bulk wipe of
 * EMBED_DIR from outside this module. Without this, a build already in
 * flight when the directory is cleared would still finish and write its
 * (now-supposed-to-be-erased) index pair straight back to disk. */
function dropAll() {
  for (const key of indexProgress.keys()) dropped.add(key);
  indexProgress.clear();
}

/** Keep EMBED_DIR under the byte cap by evicting least-recently-used index pairs. */
function pruneEmbeddings() {
  let files;
  try {
    files = fs.readdirSync(EMBED_DIR).filter(f => f.endsWith('.json')).map(f => {
      const p = path.join(EMBED_DIR, f);
      const binPath = vectorFile(p);
      const st = fs.statSync(p);
      let size = st.size;
      try { size += fs.statSync(binPath).size; } catch { /* empty index — no vectors written */ }
      return { p, binPath, size, mtimeMs: st.mtimeMs };
    });
  } catch { return; }
  let total = files.reduce((n, f) => n + f.size, 0);
  if (total <= EMBED_CACHE_MAX) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest-used first (mtime is bumped on hit)
  for (const f of files) {
    if (total <= EMBED_CACHE_MAX) break;
    try { fs.unlinkSync(f.p); } catch { /* ignore */ }
    try { fs.unlinkSync(f.binPath); } catch { /* ignore */ }
    total -= f.size;
  }
}

/** Embed an array of texts in batches; returns number[][] aligned to input. */
async function embedAll(model, texts, signal, onProgress) {
  const vectors = [];
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const vs = await llamacpp.embed(model, batch, { signal });
    if (vs.length !== batch.length) throw new Error('embed count mismatch');
    vectors.push(...vs);
    if (onProgress) onProgress(vectors.length, texts.length);
  }
  return vectors;
}

/** Return a valid cached index for `file`, or null if missing/stale. */
function tryLoadIndex(file, statSig, model, key) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.mtimeMs !== statSig.mtimeMs || c.size !== statSig.size || c.model !== model || !Array.isArray(c.chunks)) {
      return null;
    }
    let vectors = [];
    if (c.chunks.length) {
      // pre-binary-format files (no dims, or the .bin missing) just miss the cache
      if (!Number.isInteger(c.dims) || c.dims <= 0) return null;
      const buf = fs.readFileSync(vectorFile(file));
      if (buf.byteLength !== c.chunks.length * c.dims * 4) return null;
      const flat = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
      for (let i = 0; i < c.chunks.length; i++) vectors.push(flat.subarray(i * c.dims, (i + 1) * c.dims));
    }
    try { const now = new Date(); fs.utimesSync(file, now, now); } catch { /* touch for LRU */ }
    if (key) indexProgress.set(key, { state: 'ready', done: c.chunks.length, total: c.chunks.length });
    return { chunks: c.chunks, vectors };
  } catch { /* missing, stale, or corrupt pair */ }
  return null;
}

const inFlight = new Map(); // index file path -> Promise (dedup concurrent builds)

/**
 * Load a cached index for `key` (its source path), or build and persist one. The
 * index rebuilds only when the file's size/mtime or the embed model changed, and
 * concurrent requests for the same uncached file share one build (so opening a
 * chat and immediately sending don't embed the same manuscript twice).
 * Returns { chunks: [{text, offset}], vectors: number[][] }.
 */
async function loadOrBuildIndex(key, text, statSig, model, signal) {
  const file = indexFile(key);
  const cached = tryLoadIndex(file, statSig, model, key);
  if (cached) return cached;
  if (inFlight.has(file)) return inFlight.get(file);

  dropped.delete(key); // this is a fresh build; clear any stale tombstone
  const build = (async () => {
    const chunks = chunkText(text);
    if (!chunks.length) { indexProgress.set(key, { state: 'ready', done: 0, total: 0 }); return { chunks: [], vectors: [] }; }
    indexProgress.set(key, { state: 'building', done: 0, total: chunks.length });
    try {
      const vectors = await embedAll(model, chunks.map(c => asDoc(model, c.text)), signal,
        (done, total) => indexProgress.set(key, { state: 'building', done, total }));
      // detached while we were embedding? honor the drop instead of re-persisting its text
      if (dropped.has(key)) { dropped.delete(key); indexProgress.delete(key); return { chunks: [], vectors: [] }; }
      ensureDir();
      try {
        const dims = vectors.length ? vectors[0].length : 0;
        const flat = new Float32Array(vectors.length * dims);
        for (let i = 0; i < vectors.length; i++) flat.set(vectors[i], i * dims);
        fs.writeFileSync(vectorFile(file), Buffer.from(flat.buffer));
        fs.writeFileSync(file, JSON.stringify({ key, model, mtimeMs: statSig.mtimeMs, size: statSig.size, dims, chunks }));
        pruneEmbeddings();
      } catch (e) { logError('retrieval: write index', e); }
      indexProgress.set(key, { state: 'ready', done: chunks.length, total: chunks.length });
      return { chunks, vectors };
    } catch (e) {
      indexProgress.set(key, { state: 'error', done: 0, total: chunks.length });
      throw e;
    }
  })();

  inFlight.set(file, build);
  try { return await build; } finally { inFlight.delete(file); }
}

/** Kick off background index builds for items (fire-and-forget). Dedups with
 * any concurrent real request via the in-flight map. */
function warmIndex(items, model) {
  for (const it of items) {
    loadOrBuildIndex(it.path, it.text, it.statSig, model).catch(() => { /* also retried lazily on send */ });
  }
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

const readingOrder = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.chunk.offset - b.chunk.offset);

/**
 * Return the passages from `items` most relevant to `query`, greedily filling a
 * character budget.
 *
 * With an empty query (the pre-send size estimate from /context) it does NOT
 * embed or build an index — it just chunks the text and samples in reading
 * order. The injected SIZE matches the real request, which is all the estimate
 * needs, and the potentially slow index build is deferred to the first real send.
 *
 *   items: [{ path, text, statSig:{mtimeMs,size} }]
 * Returns { passages: [{ path, text }], scanned }, passages in reading order.
 * Throws only on total embed failure; callers treat a throw as "fall back to dump".
 */
async function retrieve(query, items, model, { budget, topk = RETRIEVAL_TOPK, signal } = {}) {
  const hasQuery = !!(query && query.trim());
  const scored = [];
  let scanned = 0;

  for (const it of items) {
    if (hasQuery) {
      const idx = await loadOrBuildIndex(it.path, it.text, it.statSig, model, signal);
      if (!idx || !idx.chunks.length) continue;
      scanned += idx.chunks.length;
      for (let i = 0; i < idx.chunks.length; i++) scored.push({ path: it.path, chunk: idx.chunks[i], vec: idx.vectors[i] });
    } else {
      const chunks = chunkText(it.text); // estimate only — no embedding, no index build
      scanned += chunks.length;
      for (const c of chunks) scored.push({ path: it.path, chunk: c });
    }
  }
  if (!scored.length) return { passages: [], scanned };

  if (hasQuery) {
    const [qvec] = await llamacpp.embed(model, [asQuery(model, query)], { signal });
    if (!qvec) throw new Error('query embedding failed');
    for (const s of scored) s.score = cosine(qvec, s.vec);
    scored.sort((a, b) => b.score - a.score);
  } else {
    scored.sort(readingOrder); // no query: sample the opening passages for sizing
  }

  const chosen = [];
  let used = 0;
  for (const s of scored) {
    if (chosen.length >= topk || used >= budget) break;
    chosen.push(s);
    used += s.chunk.text.length;
  }
  chosen.sort(readingOrder); // present grouped by file, in position order
  return { passages: chosen.map(s => ({ path: s.path, text: s.chunk.text })), scanned };
}

module.exports = { pickEmbedModel, embedStatus, retrieve, chunkText, dropIndex, dropAll, isEmbedName, warmIndex, indexStatusFor };
