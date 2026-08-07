/**
 * options.js — generation options, sanitized.
 *
 * MechApe's internal option shape is Ollama's (the app predates the llama.cpp
 * backend, and it's still the clearest vocabulary for these knobs), set per
 * project in the model-settings panel. Everything crossing the wire passes
 * through sanitizeOptions first: only known keys survive, numerics are
 * coerced and dropped if non-finite, and `stop` becomes a bounded string
 * array. Empty/absent values mean "use the model's default" and are simply
 * omitted. Each backend (lib/llamacpp.js, lib/openrouter.js) has its own
 * mapOptions that translates this shape into what it actually accepts on
 * the wire — NUMERIC only lists knobs at least one backend forwards; a
 * param neither backend's mapOptions reads has no business surviving here
 * either (keep this list, model-settings.js's UI, and each mapOptions in
 * sync — a param dropped from one belongs dropped from all three).
 */
const NUMERIC = [
  'num_ctx', 'temperature', 'num_predict', 'mirostat', 'mirostat_eta',
  'mirostat_tau', 'repeat_last_n', 'repeat_penalty', 'seed', 'top_k', 'top_p', 'min_p',
];

function sanitizeOptions(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;

  for (const key of NUMERIC) {
    const v = raw[key];
    if (v === '' || v == null) continue;
    const n = Number(v);
    if (Number.isFinite(n)) out[key] = n;
  }
  // cap num_ctx server-side too (the UI self-caps): a huge context is a
  // local memory-exhaustion foot-gun, and this is the authoritative check
  if (out.num_ctx) out.num_ctx = Math.min(Math.max(out.num_ctx, 256), 262144);

  if (Array.isArray(raw.stop)) {
    out.stop = raw.stop.filter(s => typeof s === 'string' && s).slice(0, 8);
  } else if (typeof raw.stop === 'string' && raw.stop.trim()) {
    out.stop = raw.stop.split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
  }
  if (out.stop && !out.stop.length) delete out.stop;

  // remote-only routing variant (OpenRouter): route to the cheapest ('floor')
  // or fastest ('nitro') provider. Ignored by the local backend.
  if (typeof raw.or_route === 'string') {
    const v = raw.or_route.trim().toLowerCase();
    if (v === 'floor' || v === 'nitro') out.or_route = v;
  }
  return out;
}

module.exports = { sanitizeOptions };
