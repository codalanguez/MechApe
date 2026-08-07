/**
 * tools.js — the bridge between a chat turn and the MCP integrations.
 *
 * WHY THIS IS A PRE-PASS RATHER THAN INLINE
 *
 * MechApe streams: routes pipe llama-server's SSE straight through to the
 * browser, translated to NDJSON, with nothing buffering in between. That is
 * what makes tokens appear as they are generated.
 *
 * Tool calling does not fit inside that. The model has to stop, be handed a
 * result, and be asked again — potentially several times — before it has
 * anything worth showing. Trying to do that mid-stream would mean detecting
 * a tool_call in a half-parsed delta, tearing down the stream, and splicing
 * a second one into the same response body. That is a lot of machinery in
 * the one code path where a bug shows up as a corrupted answer.
 *
 * So the loop runs *before* the streaming call, non-streaming:
 *
 *   1. ask the model, with tools attached
 *   2. if it wants tools, run them and append the results
 *   3. repeat until it stops asking, or the round budget runs out
 *   4. hand the enriched message list back
 *
 * The route then makes its normal streaming call with that history, and the
 * final answer streams exactly as it always did. The cost is one extra round
 * trip per tool-using turn; the benefit is that the streaming path is
 * untouched and tool failures cannot corrupt a response mid-flight.
 *
 * A turn that needs no tools costs nothing: with no integrations configured
 * the loop returns immediately without contacting the model at all.
 */
'use strict';
const mcp = require('./mcp');
const { MCP_MAX_TOOL_ROUNDS } = require('./config');
const { logInfo } = require('./log');

/**
 * Resolve any tool calls the model wants before the streamed answer.
 *
 * `chatWithTools` is injected rather than imported so this works for both
 * backends: llama-server locally, OpenRouter remotely. The two expose the
 * same signature deliberately, and the loop never learns which answered.
 *
 * `options` is threaded through because the remote adapter needs it — model
 * routing and the data_collection=deny privacy setting live there, and a
 * tool pre-pass must not be routed under looser rules than the streamed
 * turn it precedes.
 *
 * `onEvent` reports progress so the UI can say what is happening while the
 * user waits — a tool call can take seconds, and silence reads as a hang.
 *
 * Returns the message list to stream with. On any failure it returns the
 * messages untouched: a broken integration degrades the turn to an ordinary
 * chat, it does not fail it.
 */
async function resolveTools({ model, messages, options, signal, chatWithTools, onEvent = () => {} }) {
  if (!mcp.isConfigured()) return { messages, used: [] };
  if (typeof chatWithTools !== 'function') return { messages, used: [] };

  let tools;
  try {
    const started = await mcp.startAll();
    tools = started.tools;
    for (const f of started.failures) onEvent({ type: 'tool_error', server: f.server, error: f.error });
  } catch {
    return { messages, used: [] };
  }
  if (!tools.length) return { messages, used: [] };

  const history = messages.slice();
  const used = [];

  for (let round = 0; round < MCP_MAX_TOOL_ROUNDS; round++) {
    let msg;
    try {
      msg = await chatWithTools({ model, messages: history, tools, options, signal });
    } catch (e) {
      // The model errored while deciding about tools. Fall back to a plain
      // turn rather than failing: the user asked a question, not for an
      // integration status report.
      onEvent({ type: 'tool_error', error: e.message });
      return { messages, used };
    }

    // null means this model cannot call tools at all (the remote adapter
    // reports that rather than throwing). Answer the question without them.
    if (!msg) {
      onEvent({ type: 'tool_unsupported', model });
      return { messages: used.length ? history : messages, used };
    }

    const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    if (!calls.length) {
      // Nothing wanted. If tools ran earlier, keep the enriched history so
      // the streamed answer can use their results; otherwise hand back the
      // original untouched so nothing about a no-tool turn changes.
      return { messages: used.length ? history : messages, used };
    }

    history.push(msg);

    for (const call of calls) {
      const name = (call.function && call.function.name) || '';
      const args = parseArgs(call.function && call.function.arguments);
      onEvent({ type: 'tool_start', name });
      const result = await mcp.callTool(name, args);
      logInfo('mcp call', `${name} -> ${result.length} chars`);
      used.push({ name, chars: result.length });
      onEvent({ type: 'tool_done', name, chars: result.length });
      history.push({ role: 'tool', tool_call_id: call.id, name, content: result });
    }
  }

  // Budget spent and it still wants more. Stream an answer from what we have
  // rather than looping forever — a model stuck calling the same tool is a
  // real failure mode, and an answer built on four rounds of results beats
  // an error message.
  onEvent({ type: 'tool_budget' });
  return { messages: history, used };
}

/* Arguments arrive as a JSON string. A model that emits malformed JSON is
 * common enough to be worth handling: pass an empty object and let the tool
 * complain about missing arguments, which the model can then read and retry. */
function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

module.exports = { resolveTools, parseArgs };
