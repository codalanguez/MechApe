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

/* Poll transition, not poll result.
 *
 * checkHealth runs every 15s, and for most of the app's life the backend is
 * simply up — refetching the model list on every tick would be four pointless
 * requests a minute and would fight the user's selection. But the one moment
 * that mattered was never handled: when the backend comes back (llama-server
 * respawned, or someone finally started it in a repo checkout), the rail light
 * turned green while the picker still read "local backend offline", and
 * sending then produced advice to pull a model the user already had. Only
 * Ctrl+R fixed it, and that is not in the UI.
 *
 * Only the down->up edge refreshes. The up->down edge deliberately does not:
 * replacing a populated picker with "offline" would discard the user's
 * selection over what is often one flaky poll, and sending with a stale name
 * already produces a clear error from /api/chat. */
let wasUp = null;

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
      if (wasUp === false) await restoreModelList();
      wasUp = true;
    } else throw new Error();
  } catch {
    wasUp = false;
    el.className = 'status status-bad';
    el.querySelector('span').textContent = 'local backend offline';
    const hint = $('#welcome-hint');
    hint.hidden = false;
    hint.textContent = state.orConfigured
      ? "MechApe's local model backend isn't reachable, so local models are unavailable — remote (OpenRouter) models still work."
      : "MechApe's local model backend isn't reachable. In the desktop app, restart MechApe; in a repo checkout, start the llama-server chat + embed instances yourself (see the README), then this light turns green.";
  }
}

/** Repopulate the picker after an offline stretch, putting the open chat's
 *  model back in it. */
async function restoreModelList() {
  const sel = $('#model-select');
  await loadModels();
  if (sel.value) return;   // loadModels restored the previous selection itself
  /* It usually can't, here: while the backend was down the picker held a
   * single placeholder option whose value is '', so loadModels' "keep what
   * was selected" has nothing to keep. Fall back to the open chat's own
   * model — read out of state rather than imported from chat.js, which
   * imports this module and would make the cycle real. */
  const chat = state.project && state.project.chats.find(c => c.id === state.chatId);
  if (chat && chat.model && [...sel.options].some(o => o.value === chat.model)) {
    sel.value = chat.model;
  }
  updateRemoteBadge();
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
