/**
 * gguf.js — minimal, defensively-bounded GGUF header reader.
 *
 * A GGUF file is untrusted input: it's a plain file a user can drop into the
 * models folder from anywhere, so nothing here trusts a length, count, or
 * offset from the file without checking it against the buffer we actually
 * have. Every read goes through Reader, which throws Truncated instead of
 * running off the end of the buffer; every entry point catches that (and any
 * other parse error) and returns a partial/empty result rather than crashing
 * the model-info request. We only ever read the metadata KV section — tensor
 * data (the bulk of the file) is never touched, so this stays fast even on
 * a 20GB weights file.
 *
 * Spec: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */
const fsp = require('fs/promises');

const MAGIC = 0x46554747; // 'GGUF' little-endian
const HEADER_READ_CAP = 64 * 1024 * 1024; // metadata (incl. tokenizer vocab) rarely exceeds this
const MAX_KV_COUNT = 200000;     // a legitimate GGUF has dozens, not hundreds of thousands
const MAX_STRING_LEN = 8 * 1024 * 1024; // a single metadata string this long is corrupt, not real

class Truncated extends Error {}

const TYPE = { UINT8: 0, INT8: 1, UINT16: 2, INT16: 3, UINT32: 4, INT32: 5, FLOAT32: 6, BOOL: 7, STRING: 8, ARRAY: 9, UINT64: 10, INT64: 11, FLOAT64: 12 };
const SCALAR_SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

/* A pathological array-length claim (e.g. a UINT8 array declaring
 * billions of elements) would otherwise loop once per element until the
 * buffer runs out — up to HEADER_READ_CAP iterations, synchronously, inside
 * an Express request. This budget bounds total primitive reads across a
 * whole parse regardless of how the reads are distributed, so worst-case
 * work stays small and predictable no matter what a malformed file claims. */
const STEP_BUDGET = 2_000_000;

class Reader {
  constructor(buf) { this.buf = buf; this.off = 0; this.steps = STEP_BUDGET; }
  need(n) { if (--this.steps < 0) throw new Truncated(); if (this.off + n > this.buf.length) throw new Truncated(); }
  u8() { this.need(1); const v = this.buf.readUInt8(this.off); this.off += 1; return v; }
  u32() { this.need(4); const v = this.buf.readUInt32LE(this.off); this.off += 4; return v; }
  i32() { this.need(4); const v = this.buf.readInt32LE(this.off); this.off += 4; return v; }
  f32() { this.need(4); const v = this.buf.readFloatLE(this.off); this.off += 4; return v; }
  f64() { this.need(8); const v = this.buf.readDoubleLE(this.off); this.off += 8; return v; }
  /* u64/i64 as Number — GGUF counts/lengths never legitimately exceed
   * Number.MAX_SAFE_INTEGER; a value that does is already treated as corrupt. */
  u64() {
    this.need(8);
    const v = this.buf.readBigUInt64LE(this.off);
    this.off += 8;
    if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Truncated();
    return Number(v);
  }
  skip(n) { this.need(n); this.off += n; }
  string() {
    const len = this.u64();
    if (len > MAX_STRING_LEN) throw new Truncated();
    this.need(len);
    const s = this.buf.toString('utf8', this.off, this.off + len);
    this.off += len;
    return s;
  }
  /** Skip one value of `type` without materializing it (arrays included). */
  skipValue(type) {
    if (type === TYPE.STRING) { this.string(); return; }
    if (type === TYPE.ARRAY) {
      const elemType = this.u32();
      const len = this.u64();
      if (len > MAX_KV_COUNT * 50) throw new Truncated(); // absurd array length — corrupt
      for (let i = 0; i < len; i++) this.skipValue(elemType);
      return;
    }
    const size = SCALAR_SIZE[type];
    if (size == null) throw new Truncated(); // unknown type id — treat as corrupt, stop parsing
    this.skip(size);
  }
  /** Read one value of `type`, returning JS scalars for the types we care about. */
  readValue(type) {
    switch (type) {
      case TYPE.STRING: return this.string();
      case TYPE.UINT8: return this.u8();
      case TYPE.UINT32: return this.u32();
      case TYPE.INT32: return this.i32();
      case TYPE.UINT64: case TYPE.INT64: return this.u64();
      case TYPE.FLOAT32: return this.f32();
      case TYPE.FLOAT64: return this.f64();
      case TYPE.BOOL: return this.u8() !== 0;
      case TYPE.ARRAY: { // only reached if the caller explicitly wants an array value (unused today, kept for completeness)
        const elemType = this.u32();
        const len = this.u64();
        if (len > MAX_KV_COUNT * 50) throw new Truncated();
        const out = [];
        for (let i = 0; i < len; i++) out.push(this.readValue(elemType));
        return out;
      }
      default: this.skipValue(type); return null;
    }
  }
}

/* Keys worth materializing; everything else in the KV section is skipped
 * (offset advanced, bytes never copied) to keep this fast and small. */
const WANT_PREFIXES = ['general.', '.context_length', '.pooling_type', '.embedding_length'];
const wanted = (key) => WANT_PREFIXES.some(p => p.startsWith('.') ? key.endsWith(p) : key.startsWith(p));

/** Parse the metadata KV section of a GGUF file. Never throws — returns
 * `{}` (or whatever was recovered before truncation) on any parse failure,
 * since a malformed/foreign file must not take down the model-info request.
 * The file read is async (fs/promises) rather than the sync fs calls this
 * used to make: a real weights file is always bigger than HEADER_READ_CAP,
 * so this was previously a genuine 64 MB *synchronous* read on every
 * model-info request — blocking Node's single JS thread (and stalling any
 * in-flight chat stream's writes) for the duration. */
async function readMeta(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const size = (await fh.stat()).size;
    const len = Math.min(size, HEADER_READ_CAP);
    // allocUnsafe is safe here specifically because the Reader below is
    // bounded to `bytesRead` (via the subarray), not the buffer's allocated
    // length — a short read can never expose whatever was previously in
    // this memory, since the parser never looks past the confirmed-read tail.
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);

    const r = new Reader(buf.subarray(0, bytesRead));
    if (r.u32() !== MAGIC) return {};
    const version = r.u32();
    r.u64(); // tensor_count — unused, we never reach the tensor-info section
    const kvCount = r.u64();
    if (kvCount > MAX_KV_COUNT) return { version };

    const meta = { version };
    for (let i = 0; i < kvCount; i++) {
      const key = r.string();
      const type = r.u32();
      if (wanted(key)) meta[key] = r.readValue(type);
      else r.skipValue(type);
    }
    return meta;
  } catch {
    return {}; // truncated read cap, corrupt header, or not a GGUF file at all
  } finally {
    if (fh) try { await fh.close(); } catch { /* already closed */ }
  }
}

/* file_type → short quantization label (llama.cpp's `enum llama_ftype`,
 * MOSTLY_* variants). Best-effort: an unrecognized or absent value falls back
 * to the filename, which is the authoritative signal for callers anyway. */
const FILE_TYPE_LABEL = {
  0: 'F32', 1: 'F16', 2: 'Q4_0', 3: 'Q4_1', 7: 'Q8_0', 8: 'Q5_0', 9: 'Q5_1',
  10: 'Q2_K', 11: 'Q3_K_S', 12: 'Q3_K_M', 13: 'Q3_K_L', 14: 'Q4_K_S', 15: 'Q4_K_M',
  16: 'Q5_K_S', 17: 'Q5_K_M', 18: 'Q6_K', 19: 'IQ2_XXS', 20: 'IQ2_XS', 21: 'Q2_K_S',
  22: 'IQ3_XS', 23: 'IQ3_XXS', 24: 'IQ1_S', 25: 'IQ4_NL', 26: 'IQ3_S', 27: 'IQ3_M',
  28: 'IQ2_S', 29: 'IQ2_M', 30: 'IQ4_XS', 31: 'IQ1_M', 32: 'BF16',
};

/* Quant tokens as they actually appear in on-disk filenames (the convention
 * -hf/HF GGUF repos follow, e.g. "...-Q4_K_M.gguf"). Longest-match order so
 * "Q4_K_M" isn't shadowed by a bare "Q4". */
const QUANT_RE = /\b(Q\d(?:_\d)?(?:_K)?(?:_[SML])?|IQ\d_\w+|F16|F32|BF16)\b/i;

function quantFromFilename(name) {
  const m = QUANT_RE.exec(name);
  return m ? m[1].toUpperCase() : '';
}

/* "...-3B-..." / "...-8x7b-..." style size labels from a filename. */
const SIZE_RE = /\b(\d+(?:\.\d+)?x)?(\d+(?:\.\d+)?)[Bb]\b/;

function sizeFromFilename(name) {
  const m = SIZE_RE.exec(name);
  return m ? (m[1] ? `${m[1]}${m[2]}B` : `${m[2]}B`) : '';
}

/**
 * Full model-info summary for one .gguf file, filling any metadata gap from
 * the filename. Matches the shape public/js/model-info.js already renders.
 */
async function describeModel(filePath, fileName) {
  const meta = await readMeta(filePath);
  const arch = typeof meta['general.architecture'] === 'string' ? meta['general.architecture'] : '';

  let contextLength = null;
  if (arch && Number.isFinite(meta[`${arch}.context_length`])) contextLength = meta[`${arch}.context_length`];
  else {
    // architecture-prefixed key wasn't captured (unknown prefix) — scan what we did keep
    for (const k in meta) if (k.endsWith('.context_length') && Number.isFinite(meta[k])) { contextLength = meta[k]; break; }
  }

  const parameterSize = (typeof meta['general.size_label'] === 'string' && meta['general.size_label'])
    || sizeFromFilename(fileName) || '';

  const quantization = FILE_TYPE_LABEL[meta['general.file_type']] || quantFromFilename(fileName) || '';

  const isEmbedding = Object.keys(meta).some(k => k.endsWith('.pooling_type'));

  return {
    name: (typeof meta['general.name'] === 'string' && meta['general.name']) || fileName,
    architecture: arch,
    parameterSize,
    quantization,
    contextLength,
    isEmbedding,
    capabilities: [], // GGUF has no Ollama-style capabilities list; caller falls back to name heuristics
  };
}

module.exports = { readMeta, describeModel, quantFromFilename, sizeFromFilename };
