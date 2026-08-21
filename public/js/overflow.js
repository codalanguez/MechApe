/**
 * overflow.js — the "too long for the context" dialog.
 *
 * Shown by chat.js when a request can't be compacted to fit — i.e. the system
 * prompt and attached files alone exceed the context length, so dropping older
 * messages wouldn't help. Offers three ways forward: raise the context length
 * to the next tier that fits, start a fresh chat, or send anyway (letting the
 * model drop the oldest text). send()/newChat() arrive as callbacks from
 * main.js so this module doesn't depend on chat.js (no import cycle).
 */
import { $, toast } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { neededContext } from './context-meter.js';
import { fmtCtx } from './util.js';
import { initModal } from './modal.js';

let overflowText = '';
let modal;
let sendFn;
let newChatFn;

/** Populate and show the dialog for a request that overflows on `text`. */
export function openOverflowDialog(text) {
  overflowText = text;
  $('#of-msg').textContent =
    `This request needs more room than the context length (${fmtCtx(state.contextLimit)} tokens) allows, and it can't be trimmed by dropping older messages — the project's instructions and attached files alone fill it. Choose how to proceed:`;

  /* Say what "increase" would actually set, and carry over the VRAM warning
   * from Model settings.
   *
   * Without both, this button was a closed loop: it silently jumped num_ctx to
   * the next power of two that fits — up to 256k — the next send ran out of
   * VRAM loading the KV cache, and the error told the user to *lower* the
   * context length they had just been invited to raise, with nothing
   * connecting the two moments. The same numbers already carry a warning in
   * Model settings; the dialog that recommends them should not be the one
   * place it is missing. */
  const ctx = neededContext(overflowText);
  $('#of-increase-note').textContent = `to ${fmtCtx(ctx)} · may slow responses`;
  const warn = $('#of-ctx-warn');
  warn.hidden = ctx < 65536;
  if (!warn.hidden) {
    warn.textContent = ctx >= 131072
      ? `⚠ ${fmtCtx(ctx)} needs many GB of VRAM for the KV cache — on most GPUs the model will fail to load or crash. Consider "Send anyway", or attaching less.`
      : `⚠ ${fmtCtx(ctx)} is memory-hungry and can exceed a typical GPU, making the model fail to load. With on-device retrieval, large attachments don't need a big context.`;
  }

  modal.open();
}

/** Wire the dialog once. `send` and `newChat` come from chat.js via main.js. */
export function initOverflowDialog(send, newChat) {
  sendFn = send;
  newChatFn = newChat;
  modal = initModal('#overflow-backdrop', '#btn-close-overflow');

  $('#btn-of-increase').addEventListener('click', async () => {
    const ctx = neededContext(overflowText);
    state.project.options = { ...(state.project.options || {}), num_ctx: ctx };
    state.contextLimit = ctx;
    await api(`/api/projects/${state.project.id}`, { method: 'PUT', body: { options: state.project.options } });
    modal.close();
    // name the scope: this is a project-wide setting, not a one-off for this
    // message, and every other chat in the project inherits it
    toast(`Context raised to ${fmtCtx(ctx)} for every chat in this project`);
    sendFn(true);
  });

  $('#btn-of-newchat').addEventListener('click', async () => {
    modal.close();
    await newChatFn();
    sendFn(true);
  });

  $('#btn-of-send').addEventListener('click', () => { modal.close(); sendFn(true); });
}
