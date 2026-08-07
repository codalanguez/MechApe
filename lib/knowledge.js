/**
 * knowledge.js — assemble the "# Knowledge" section of the system prompt.
 *
 * For each attachment it decides between two modes under a shared byte budget:
 *   - dump: small files/dirs go into the prompt whole (as before), and
 *   - retrieve: a large file/dir is embedded once and only the passages most
 *     relevant to the current question are injected (lib/retrieval).
 *
 * Retrieval only engages when it's both possible and worthwhile — an embed
 * model is installed, the attachment is over RETRIEVAL_MIN_CHARS, and we have a
 * question to rank against. Anything else (no model, small file, no query yet,
 * or an embedding error) falls back to the plain dump, so behavior degrades
 * gracefully and chat never breaks because of retrieval.
 */
const fs = require('fs');
const {
  TOTAL_BUDGET, RETRIEVAL, RETRIEVAL_MIN_CHARS, RETRIEVAL_BUDGET,
  INDEX_FILE_MAX, INDEX_DIR_FILE_MAX,
} = require('./config');
const { pathAllowed } = require('./security');
const { dumpAttachment, readForIndex, collectDirFiles, dirFilePaths, forgetCached, attachmentContext, looksLikeInjection, untrustedNote } = require('./attachments');
const { pickEmbedModel, retrieve, warmIndex, dropIndex } = require('./retrieval');
const { logError } = require('./log');

function statSig(p) { const st = fs.statSync(p); return { mtimeMs: st.mtimeMs, size: st.size }; }

/** Gather the indexable items for an attachment if it's large enough to retrieve. */
function retrievalItems(att) {
  if (att.type === 'file') {
    const sig = statSig(att.path);
    if (sig.size <= RETRIEVAL_MIN_CHARS) return null;
    const text = readForIndex(att.path, INDEX_FILE_MAX);
    return text ? [{ path: att.path, text, statSig: sig }] : null;
  }
  // directory: index it only if the whole tree is large
  const { files } = collectDirFiles(att.path, { perFileLimit: INDEX_DIR_FILE_MAX, budget: INDEX_FILE_MAX * 4, forIndex: true });
  const total = files.reduce((n, f) => n + f.text.length, 0);
  if (total <= RETRIEVAL_MIN_CHARS || !files.length) return null;
  return files.map(f => ({ path: f.path, text: f.text, statSig: statSig(f.path) }));
}

/**
 * Build the knowledge parts for a set of attachments.
 * Returns { parts, errors } — same shape the prompt builder expects.
 */
async function assembleKnowledge(attachments, { query } = {}) {
  if (!attachments || !attachments.length) return { parts: [], errors: [] };

  // Retrieval needs an installed embed model; without one, dump everything as
  // before. With a model but no query (the pre-send estimate), retrieval still
  // runs — it samples passages so the size estimate matches the real request.
  const model = RETRIEVAL ? await pickEmbedModel() : null;
  if (!model) return attachmentContext(attachments);

  const parts = [];
  const errors = [];
  let budget = TOTAL_BUDGET;

  for (const att of attachments) {
    if (budget <= 0) { errors.push(`${att.path}: skipped (context budget exhausted)`); continue; }
    // gate BOTH paths here: the retrieval read (readForIndex) has no allowlist
    // check of its own, and dumpAttachment re-checks for the fallback path.
    if (!pathAllowed(att.path)) { errors.push(`${att.path}: outside MECHAPE_FS_ROOTS, not included`); continue; }

    let items = null;
    try { items = retrievalItems(att); }
    catch (e) { errors.push(`${att.path}: ${e.message}`); continue; }

    if (items) {
      try {
        const { passages, scanned } = await retrieve(query, items, model, { budget: Math.min(RETRIEVAL_BUDGET, budget) });
        if (passages.length) {
          const blocks = passages.map(p => `<passage path="${p.path}">\n${p.text}\n</passage>`).join('\n\n');
          budget -= passages.reduce((n, p) => n + p.text.length, 0);
          parts.push(
            `<retrieved source="${att.path}" note="the ${passages.length} passages most relevant to the question` +
            ` (from ${scanned} indexed chunks); the full attachment is too large to include whole">\n${blocks}\n</retrieved>`
          );
          if (looksLikeInjection(blocks)) errors.push(untrustedNote(att.path));
          continue;
        }
      } catch (e) { logError(`retrieval "${att.path}"`, e); /* fall through to dump */ }
    }

    // dump path: small attachment, or retrieval unavailable/failed for this one
    const r = dumpAttachment(att, budget);
    budget -= r.used;
    parts.push(...r.parts);
    errors.push(...r.errors);
  }

  return { parts, errors };
}

/**
 * Start building the embedding index for an attachment in the background, if
 * it's large enough to retrieve and an embed model is available. Safe to call
 * fire-and-forget on attach, so the first message doesn't wait on the build.
 * (Indexing still happens lazily on send if this is skipped or fails.)
 */
async function warmAttachment(att) {
  try {
    if (!RETRIEVAL || !att || !pathAllowed(att.path)) return;
    const model = await pickEmbedModel();
    if (!model) return;
    const items = retrievalItems(att);
    if (items) warmIndex(items, model);
  } catch (e) { logError(`warm index "${att && att.path}"`, e); }
}

/**
 * Forget everything cached for an attachment when it's detached or its
 * project/chat is deleted: the on-disk embedding index — for a directory, every
 * member file is indexed separately, so drop them all — plus the in-memory read
 * cache, so no attachment text lingers after removal.
 */
function forgetAttachment(att) {
  if (!att || !att.path) return;
  const paths = new Set([att.path]);
  if (att.type === 'dir') { try { for (const p of dirFilePaths(att.path)) paths.add(p); } catch { /* dir gone */ } }
  for (const p of paths) { dropIndex(p); forgetCached(p); }
}

module.exports = { assembleKnowledge, warmAttachment, forgetAttachment };
