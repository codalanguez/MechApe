/**
 * api.js — thin JSON client for the MechApe backend.
 *
 * Wraps fetch with JSON headers/body handling and turns non-2xx responses
 * into thrown Errors carrying the server's error message plus its HTTP
 * status and the full JSON body (under `.body`, not spread onto the Error
 * instance — a route could otherwise return a field like `message` or
 * `stack` that shadows the Error's own), so callers that need to branch on
 * more than the message text (e.g. a 409 `{exists:true}`) can read
 * `e.body.exists`. Callers that just want the message can simply try/catch
 * and toast. (The streaming /api/chat call does NOT go through here —
 * chat.js consumes that stream directly.)
 */
export async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, body: data });
  return data;
}
