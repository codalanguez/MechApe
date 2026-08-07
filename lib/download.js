/**
 * download.js — stream a fetch Response body to disk, safely.
 *
 * Shared by lib/llamacpp.js (pulling a model from Hugging Face) and
 * electron/llamacpp.js (fetching the llama-server binary from GitHub) — both
 * are "long download over HTTPS, must not corrupt the destination if it
 * fails partway" and were, before this, two independently-maintained copies
 * of the same read/write loop that had already drifted (one had the atomic
 * rename and size cap, the other didn't). One implementation now.
 *
 * Always writes to `<dest>.part` and renames onto `dest` only after the
 * write stream closes successfully — a failed or aborted download never
 * leaves a file at `dest` that looks complete, and any error cleans up the
 * partial file rather than leaving debris behind.
 */
const fs = require('fs');

/**
 * @param {ReadableStream} body - a fetch Response's .body
 * @param {string} dest - final destination path
 * @param {object} [opts]
 * @param {number} [opts.total] - expected total bytes (for progress reporting), 0 if unknown
 * @param {number} [opts.maxBytes] - throw if the download exceeds this many bytes
 * @param {(completed: number, total: number) => void} [opts.onProgress]
 * @param {() => Promise<void>} [opts.beforeRename] - runs after the write completes but
 *   before the atomic rename, e.g. to release a lock on `dest` (see lib/llamacpp.js:
 *   re-pulling a model currently loaded by a running llama-server instance)
 */
async function streamToFile(body, dest, { total = 0, maxBytes = Infinity, onProgress, beforeRename } = {}) {
  const tmp = dest + '.part';
  const reader = body.getReader();
  const ws = fs.createWriteStream(tmp);
  let completed = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      completed += value.byteLength;
      if (completed > maxBytes) throw new Error('download exceeded the safety size cap');
      await new Promise((res, rej) => ws.write(Buffer.from(value), (e) => (e ? rej(e) : res())));
      if (onProgress) onProgress(completed, total);
    }
    await new Promise((res, rej) => ws.end((e) => (e ? rej(e) : res())));
    if (beforeRename) await beforeRename();
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { ws.destroy(); } catch { /* already gone */ }
    try { fs.unlinkSync(tmp); } catch { /* nothing partial to clean up */ }
    throw e;
  }
}

module.exports = { streamToFile };
