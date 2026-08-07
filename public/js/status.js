/**
 * status.js — local backend connection status and model list.
 *
 * Owns the sidebar health indicator (polled every 15s) and the model
 * <select> population.
 */
import { $, esc } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { orFavorites, isRemoteModel, OR_PREFIX } from './openrouter.js';

export async function checkHealth() {
  const el = $('#local-status');
  try {
    const h = await api('/api/health');
    if (h.ok) {
      el.className = 'status status-ok';
      // name the accelerator when we know it — a silent fall back to CPU
      // (no GPU found, or a model that wouldn't fit in VRAM) should be
      // visible here rather than just feeling mysteriously slow
      el.querySelector('span').textContent = h.accel ? `local models · ${h.accel}` : 'local models ready';
      el.title = h.accel === 'CPU'
        ? 'Running on CPU — either no supported GPU was found, or the model would not load on it. Generation will be slower.'
        : '';
      $('#welcome-hint').hidden = true;
    } else throw new Error();
  } catch {
    el.className = 'status status-bad';
    el.querySelector('span').textContent = 'local backend offline';
    const hint = $('#welcome-hint');
    hint.hidden = false;
    hint.textContent = state.orConfigured
      ? "MechApe's local model backend isn't reachable, so local models are unavailable — remote (OpenRouter) models still work."
      : "MechApe's local model backend isn't reachable. In the desktop app, restart MechApe; in a repo checkout, start the llama-server chat + embed instances yourself (see the README), then this light turns green.";
  }
}

/** "☁ remote" chip beside the picker — visible when the selected model runs
 * off-machine, so it's always obvious where a chat's text goes. */
export function updateRemoteBadge() {
  $('#remote-badge').hidden = !isRemoteModel($('#model-select').value);
}

export async function loadModels() {
  const sel = $('#model-select');
  const prev = sel.value;
  let local = [];
  let backendUp = true;
  try {
    local = (await api('/api/models')).models;
  } catch { backendUp = false; }
  state.models = local;

  const favs = state.orConfigured ? orFavorites() : [];
  if (!local.length && !favs.length) {
    sel.innerHTML = backendUp
      ? '<option value="">no models — pull one from Manage models</option>'
      : '<option value="">local backend offline</option>';
  } else {
    const localOpts = local.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('');
    const remoteOpts = favs.map(f => `<option value="${OR_PREFIX}${esc(f.id)}">☁ ${esc(f.name || f.id)}</option>`).join('');
    sel.innerHTML =
      (local.length ? `<optgroup label="On this machine">${localOpts}</optgroup>` : '') +
      (favs.length ? `<optgroup label="OpenRouter — remote">${remoteOpts}</optgroup>` : '');
    if (prev && [...sel.options].some(o => o.value === prev)) sel.value = prev;
  }
  updateRemoteBadge();
}
