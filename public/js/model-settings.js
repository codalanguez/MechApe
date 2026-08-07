/**
 * model-settings.js — per-project generation options.
 *
 * A modal (opened from the gear beside the model picker) edits the options
 * applied to every chat in the current project: model, context length, and
 * temperature up top, the rest under a collapsible "Advanced settings".
 * Values persist on the project (PUT /api/projects/:id) and ride along with
 * each /api/chat request via chat.js. Empty advanced fields are omitted so
 * the model's own default applies; the server sanitizes everything again.
 * The option set is Ollama-shaped (see lib/options.js) but works against
 * either backend — each has its own mapOptions translating what it accepts.
 */
import { $, esc, toast, fmtCtx } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { updateModelInfo } from './model-info.js';

/* Advanced params: [key, label, description, placeholder]. num_ctx/temperature
 * live in the always-visible section, so they are not repeated here. */
const ADVANCED = [
  ['num_predict', 'Max tokens', 'Maximum number of tokens to generate. Empty = model default.', '4096'],
  ['mirostat', 'mirostat', 'Mirostat sampling for perplexity control (0 = off, 1 = v1, 2 = v2).', '0'],
  ['mirostat_eta', 'mirostat_eta', 'How quickly Mirostat responds to feedback. (Default 0.1)', '0.10'],
  ['mirostat_tau', 'mirostat_tau', 'Balance of coherence vs diversity. (Default 5.0)', '5.00'],
  ['repeat_last_n', 'repeat_last_n', 'How far back to look to prevent repetition. (Default 64, 0 = off, -1 = num_ctx)', '64'],
  ['repeat_penalty', 'repeat_penalty', 'How strongly to penalize repetition. (Default 1.1)', '1.10'],
  ['seed', 'seed', 'Random seed. A fixed value makes generation reproducible.', '0'],
  ['top_k', 'top_k', 'Limits token choices; lower is more conservative. (Default 40)', '40'],
  ['top_p', 'top_p', 'Nucleus sampling; lower is more focused. (Default 0.9)', '0.90'],
  ['min_p', 'min_p', 'Minimum token probability relative to the most likely. (Default 0.0)', '0.00'],
  ['stop', 'stop', 'Stop sequences, comma-separated. Generation halts when one is produced.', 'stop, \\n, user:'],
  ['or_route', 'or_route', 'Remote (OpenRouter) routing: floor = cheapest provider, nitro = fastest. Local models ignore this.', 'floor or nitro'],
];

const ctxLabel = (pow) => fmtCtx(2 ** pow);

function renderAdvanced() {
  $('#ms-advanced-fields').innerHTML = ADVANCED.map(([key, label, desc, ph]) => `
    <label class="ms-adv-field">
      <span class="ms-adv-name">${esc(label)}</span>
      <span class="ms-adv-desc">${esc(desc)}</span>
      <input data-opt="${esc(key)}" type="text" placeholder="${esc(ph)}">
    </label>`).join('');
}

/** Populate the model dropdown; mirrors the chat-header select. */
function fillModels() {
  const header = $('#model-select');
  $('#ms-model').innerHTML = header.innerHTML;
  $('#ms-model').value = header.value;
}

/** Warn when the context length is set beyond what a typical GPU can hold — a
 * too-high value makes the model's KV cache exceed VRAM and fail to load/crash. */
function updateCtxWarn(pow) {
  const warn = $('#ms-ctx-warn');
  if (pow < 16) { warn.hidden = true; return; } // ≤ 32k is fine on most GPUs
  warn.hidden = false;
  warn.textContent = pow >= 17
    ? `⚠ ${ctxLabel(pow)} needs many GB of VRAM for the KV cache — on most GPUs the model will fail to load or crash. Lower it unless you have the memory to spare.`
    : `⚠ ${ctxLabel(pow)} is memory-hungry and can exceed a typical GPU, making the model fail to load. With on-device retrieval, large attachments don't need a big context.`;
}

/** Load the current project's saved options into the controls. */
function load() {
  fillModels();
  updateModelInfo($('#ms-model').value);
  const o = state.project?.options || {};

  const pow = o.num_ctx ? Math.round(Math.log2(o.num_ctx)) : 12;
  const clamped = Math.min(18, Math.max(12, pow));
  $('#ms-num_ctx').value = clamped;
  $('#ms-ctx-out').textContent = ctxLabel(clamped);
  updateCtxWarn(clamped);

  const temp = o.temperature != null ? o.temperature : 1;
  $('#ms-temperature').value = temp;
  $('#ms-temp-out').textContent = Number(temp).toFixed(2);

  for (const [key] of ADVANCED) {
    const el = $(`#ms-advanced-fields [data-opt="${key}"]`);
    if (el) el.value = o[key] != null ? o[key] : '';
  }
}

/** Collect the controls into an options object (empties omitted). */
function collect() {
  const o = {
    num_ctx: 2 ** Number($('#ms-num_ctx').value),
    temperature: Number($('#ms-temperature').value),
  };
  for (const [key] of ADVANCED) {
    const v = $(`#ms-advanced-fields [data-opt="${key}"]`).value.trim();
    if (v !== '') o[key] = v;
  }
  return o;
}

async function save() {
  if (!state.project) return;
  const options = collect();
  state.project.options = options;
  try {
    await api(`/api/projects/${state.project.id}`, { method: 'PUT', body: { options } });
  } catch (e) { toast(e.message, true); }
}

export function initModelSettings(openModal) {
  renderAdvanced();

  $('#btn-model-settings').addEventListener('click', () => { load(); openModal(); });

  // model choice is shared with the header select, both directions
  $('#ms-model').addEventListener('change', () => {
    $('#model-select').value = $('#ms-model').value;
    $('#model-select').dispatchEvent(new Event('change'));
    updateModelInfo($('#ms-model').value);
  });

  $('#ms-num_ctx').addEventListener('input', () => {
    const pow = Number($('#ms-num_ctx').value);
    $('#ms-ctx-out').textContent = ctxLabel(pow);
    updateCtxWarn(pow);
  });
  $('#ms-temperature').addEventListener('input', () => {
    $('#ms-temp-out').textContent = Number($('#ms-temperature').value).toFixed(2);
  });

  // persist on any change (sliders on release, text fields on blur/enter)
  const panel = $('#model-settings-panel');
  panel.addEventListener('change', save);
}
