/**
 * sse.js — OpenAI-style SSE → Ollama-shaped NDJSON.
 *
 * Both remote backends MechApe can talk to (OpenRouter, and the self-hosted
 * llama.cpp server) speak the same OpenAI chat-completions SSE wire format
 * (`data: {...choices[0].delta.content}` lines, `:` keepalive comments, a
 * final `data: [DONE]`). This is the one translator both adapters share, so
 * routes, the stream tee, and the browser parsers never know which backend
 * answered: `{message:{content}}` / `{message:{thinking}}` NDJSON lines in,
 * a trailing `{done:true}` out.
 */

const MAX_SSE_LINE = 1024 * 1024; // no legitimate delta event approaches 1 MB

/**
 * `onUsage(o)` — optional hook for backend-specific usage/cost extraction from
 * the raw parsed event (OpenRouter reports `usage.cost`; llama.cpp doesn't
 * wire this up today, though its own `usage` field is there for the taking).
 * Returning a value from it emits `{usage: value}` — a backend-neutral field
 * name, since this translator is shared infrastructure both backends funnel
 * through and routes/chat.js code must be able to read one field regardless
 * of which one answered. Returning nothing emits nothing extra for that event.
 */
function sseToNdjson(body, { onUsage } = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buf = '';
  const emit = (controller, obj) => controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      buf += decoder.decode(chunk, { stream: true });
      // a newline-less line growing without bound means a broken upstream —
      // fail loudly instead of buffering it into local memory forever
      if (buf.length > MAX_SSE_LINE) {
        emit(controller, { error: 'Malformed stream from the provider (oversized event) — try again.' });
        controller.terminate();
        return;
      }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line || line.startsWith(':')) continue;        // SSE keepalive comment
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') continue;                 // flush() emits done
        try {
          const o = JSON.parse(payload);
          // mid-stream provider errors arrive as {error:{message}} events
          if (o.error) { emit(controller, { error: o.error.message || String(o.error) }); continue; }
          const delta = o.choices && o.choices[0] && o.choices[0].delta;
          // reasoning models stream their thinking as a separate field —
          // surface it Ollama-style so the UI can show a "thinking…" block
          if (delta && delta.reasoning) emit(controller, { message: { thinking: delta.reasoning } });
          if (delta && delta.content) emit(controller, { message: { content: delta.content } });
          if (onUsage) {
            const usage = onUsage(o);
            if (usage) emit(controller, { usage });
          }
        } catch { /* malformed event line — skip it */ }
      }
    },
    flush(controller) { emit(controller, { done: true }); }
  }));
}

module.exports = { sseToNdjson, MAX_SSE_LINE };
