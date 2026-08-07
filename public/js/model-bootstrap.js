/**
 * model-bootstrap.js — first-run offers to pull the models MechApe needs.
 *
 * On a clean install with no models, chatting is impossible and large-attachment
 * search is unavailable. The desktop shell offers (once each) to pull a small
 * default chat model and the recommended embedding model, streamed in the
 * background so you can keep working. In plain browser mode there's no native
 * prompt — you pull from the model manager instead.
 */
import { toast, readNdjson } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { loadModels } from './status.js';

/** Run both first-run checks — chat first, since it's the one you can't work without. */
export async function checkModels() {
  await checkChatModel();
  await checkEmbedModel();
}

let chatChecked = false;
async function checkChatModel() {
  if (chatChecked) return;
  chatChecked = true;
  let status;
  try { status = await api('/api/chat-status'); } catch { return; }
  if (status.hasChatModel) return;                 // already have something to chat with
  if (state.orConfigured) return;                  // remote models cover chatting — don't nag
  if (!window.mechape?.chatModelPrompt) return;     // browser mode: stay silent
  const choice = await window.mechape.chatModelPrompt({ recommended: status.recommended, size: status.size });
  if (choice === 'download') {
    await pullModel(status.recommended, `${status.recommended} ready — pick it in the model selector to start chatting.`);
    await loadModels(); // the freshly pulled model now shows up in the picker
  }
}

let embedChecked = false;
async function checkEmbedModel() {
  if (embedChecked) return;
  embedChecked = true;
  let status;
  try { status = await api('/api/embed-status'); } catch { return; }
  if (status.installed) return;                    // already have one — nothing to do
  if (!window.mechape?.embedModelPrompt) return;    // browser mode: stay silent
  const choice = await window.mechape.embedModelPrompt({ recommended: status.recommended, size: status.size });
  if (choice === 'download') await pullModel(status.recommended, `${status.recommended} ready — large attachments are now searched offline instead of truncated.`);
}

/** Stream a model pull with start/finish toasts; runs in the background. */
async function pullModel(name, doneMsg) {
  toast(`Downloading ${name} — this runs once and continues in the background.`);
  try {
    const res = await fetch('/api/models/pull', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    for await (const o of readNdjson(res)) { if (o.error) throw new Error(o.error); }
    toast(doneMsg);
  } catch (e) {
    toast(`${name} download failed: ${e.message}`, true);
  }
}
