/**
 * stream.js — tee an NDJSON upstream to the client while inspecting it.
 *
 * Both the chat and model-pull routes forward the backend's raw NDJSON bytes to
 * the browser unchanged AND parse each line for a side effect (accumulate the
 * reply / scan for an error event). This shares that loop: raw chunks are
 * written through verbatim; every complete JSON line is handed to `onObj`.
 * Reader errors (e.g. client abort) propagate to the caller.
 */
async function pipeNdjson(upstream, res, onObj) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl).trim();
      buffered = buffered.slice(nl + 1);
      if (!line) continue;
      try { onObj(JSON.parse(line)); } catch { /* partial or non-JSON line */ }
    }
    res.write(value);
  }
}

module.exports = { pipeNdjson };
