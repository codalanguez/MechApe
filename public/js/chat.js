/**
 * chat.js — conversations: the chat list, message rendering, and streaming.
 *
 * Owns everything that happens inside a chat: creating/opening/deleting
 * chats, rendering the message history (markdown for the model, escaped
 * plaintext for the user), and send() — which POSTs to /api/chat, consumes
 * the backend's NDJSON stream chunk by chunk, re-renders markdown at most
 * every 80ms, keeps the view pinned to the bottom unless the user scrolled
 * up, and supports mid-generation Stop.
 */
import { $, esc, toast, readNdjson, copyText } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { md } from './markdown.js';
import { skillNames, renderSkillChips } from './skills.js';
import { showView } from './views.js';
import { refreshContext, clearContext, willOverflow, cannotCompact } from './context-meter.js';
import { updateRemoteBadge } from './status.js';
import { isRemoteModel } from './openrouter.js';
import { confirmDialog } from './confirm.js';
import { openOverflowDialog } from './overflow.js';
import { renderChatAttachments } from './attachments.js';
import { saveAsFile } from './savefile.js';

const THINKING_DOTS = '<span class="thinking-dots"><i></i><i></i><i></i></span>';

// A LOCAL chat instance that crashes mid-generation surfaces as raw socket
// text forwarded straight through the stream. Translate that to a
// plain-language cause — but only for local models: a remote provider's
// "connection reset" is their outage, not your GPU, and the advice would be
// wrong. (The server already rewrites load-time crashes, whose message no
// longer contains these keywords, so this won't touch it.)
// Keep this pattern identical to RUNNER_CRASH_RE in routes/models.js.
const RUNNER_CRASH_RE = /wsarecv|forcibly closed|connection reset|econnreset|broken pipe|process (has )?terminated|exit status|unexpected eof|out of memory|cudamalloc|cuda error|insufficient memory|failed to allocate/i;
const humanizeError = (msg, model) => (isRemoteModel(model) || !RUNNER_CRASH_RE.test(msg || ''))
  ? msg
  : "The model's runner ran out of GPU memory and crashed. Lower the context length in Model settings, pick a smaller model, or close other GPU apps.";

/* ---- reasoning + cost display (remote models) ---- */

/** Collapsible "thinking" block for reasoning models; open while it's all we have. */
function thinkingHtml(t, open = false) {
  if (typeof t !== 'string' || !t) return ''; // stored files may hold anything
  return `<details class="think"${open ? ' open' : ''}><summary>thinking</summary><div class="think-body">${md(t)}</div></details>`;
}

// Token counts come from a remote API and old store files could hold anything —
// coerce so nothing but digits ever reaches the HTML below. (1000-based on
// purpose: these are token counts, not 1024-based context windows like fmtCtx.)
const fmtTok = (n) => { const x = Number(n) || 0; return x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x); };
const fmtUsd = (c) => `$${c < 0.01 ? c.toFixed(4) : c.toFixed(2)}`;
const validCost = (c) => typeof c === 'number' && Number.isFinite(c);

/** Per-reply usage line: exact cost + token counts (remote replies only). */
function usageMeta(u) {
  if (!u) return '';
  const cost = validCost(u.cost) ? `${fmtUsd(u.cost)} · ` : '';
  return `<div class="msg-usage">${cost}${fmtTok(u.promptTokens)} in / ${fmtTok(u.completionTokens)} out</div>`;
}

/**
 * Attribution line under a reply: which integrations ran, and anything that
 * stopped one from running.
 *
 * The server has been writing a {"tools":[…]} line into the stream all along,
 * with a comment saying it exists so a reply that leaned on an integration
 * says so "instead of appearing to know things by magic" — and the NDJSON
 * loop below simply never read it. So the guarantee was true of the wire and
 * false of the product, in exactly the case that matters most: a remote chat
 * where a filesystem tool has just sent local file contents to a provider,
 * and the answer reads like ordinary model knowledge.
 *
 * Deliberately quiet — one dim line, the same weight as the token/cost line,
 * left-aligned so it reads as provenance attached to the answer while cost
 * stays a right-aligned meter.
 */
function toolsMeta(used, notes) {
  const parts = [];
  if (used && used.length) parts.push(`used ${used.map(t => t.name).join(', ')}`);
  if (notes && notes.length) parts.push(...notes);
  return parts.length ? `<div class="msg-tools">⚙ ${esc(parts.join(' · '))}</div>` : '';
}

/** The body of a stored assistant turn: an error, or an answer that may have
 *  been cut short. Both shapes are persisted now, so both have to render the
 *  same on reload as they did live. */
function assistantBody(m) {
  if (m.error) return `<p style="color:var(--blood)">⚠ ${esc(m.error)}</p>`;
  return thinkingHtml(m.thinking) + md(m.content) + (m.stopped ? '<p><em>— stopped —</em></p>' : '');
}

/** Running OpenRouter spend for the open chat, shown in the header. */
export function updateChatCost() {
  const el = $('#chat-cost');
  const chat = state.project && currentChat();
  const total = chat ? chat.messages.reduce((s, m) => s + (m.usage && validCost(m.usage.cost) ? m.usage.cost : 0), 0) : 0;
  el.hidden = !total;
  if (total) el.textContent = `Σ ${fmtUsd(total)}`;
}

/** Toggle streaming state and the send/stop button pair together. */
function setStreaming(on) {
  state.streaming = on;
  $('#btn-send').hidden = on;
  $('#btn-stop').hidden = !on;
  updateStopTitle();
}

/** Name the chat Stop would actually stop.
 *
 * The button is global but a stream belongs to one chat, so after switching
 * away it offers to stop a reply that is not the one on screen. Saying which
 * costs a tooltip and removes the ambiguity entirely. */
function updateStopTitle() {
  const btn = $('#btn-stop');
  if (!btn || btn.hidden) return;
  const streaming = state.streamChatId
    && state.project
    && state.project.chats.find(c => c.id === state.streamChatId);
  btn.title = (streaming && state.streamChatId !== state.chatId)
    ? `Stop the reply generating in "${streaming.title}"`
    : 'Stop generating';
}

export function currentChat() {
  return state.project.chats.find(c => c.id === state.chatId);
}

export function renderChatList() {
  const ul = $('#chat-list');
  ul.innerHTML = state.project.chats.map(c => `
    <li data-id="${c.id}" class="${c.id === state.chatId ? 'active' : ''}">
      <span>${esc(c.title)}</span>
      <button class="del" data-del="${c.id}" title="Delete chat">×</button>
    </li>`).join('');
  ul.querySelectorAll('li').forEach(li =>
    li.addEventListener('click', (e) => { if (!e.target.dataset.del) openChat(li.dataset.id); }));
  ul.querySelectorAll('[data-del]').forEach(b =>
    b.addEventListener('click', () => deleteChat(b.dataset.del)));
}

export async function deleteChat(cid) {
  await api(`/api/projects/${state.project.id}/chats/${cid}`, { method: 'DELETE' });
  state.project.chats = state.project.chats.filter(c => c.id !== cid);
  if (state.chatId === cid) {
    state.chatId = null;
    if (state.project.chats.length) openChat(state.project.chats[0].id); else newChat();
  } else renderChatList();
}

/** Render a chat's full history as a Markdown transcript — headings for
 *  speaker turns, the raw stored content underneath (not a rendered/
 *  flattened copy, so bold/code/links survive round-tripping back in). */
function chatToMarkdown(chat) {
  const lines = [`# ${chat.title}`, ''];
  for (const m of chat.messages) {
    // a failed turn is kept in the chat so its diagnostic survives a reload,
    // but it is not part of the conversation anyone wants to export
    if (m.error) continue;
    lines.push(`### ${m.role === 'user' ? 'You' : (m.model || 'Model')}`, '', m.content, '');
  }
  return lines.join('\n').trim() + '\n';
}

/** Copy a chat's whole conversation to the clipboard as Markdown. Defaults
 *  to the open chat, but takes an explicit id so it works from the chat-list
 *  context menu on a chat that isn't the one currently open. */
export function copyConversationMarkdown(cid = state.chatId) {
  const chat = state.project?.chats.find(c => c.id === cid);
  if (!chat || !chat.messages.length) { toast('Nothing to copy', true); return; }
  copyText(chatToMarkdown(chat));
  toast('Conversation copied as Markdown');
}

/** Save a chat's whole conversation to disk as Markdown, via the same
 *  folder-pick + filename flow as a per-message save. */
export function saveConversationAsFile(cid = state.chatId) {
  const chat = state.project?.chats.find(c => c.id === cid);
  if (!chat || !chat.messages.length) { toast('Nothing to save', true); return; }
  saveAsFile(chatToMarkdown(chat), chat.title);
}

/** Wipe a chat's messages (keeps the chat, model, and attachments), resetting
 * the context it had built up. Confirms first, since it's not undoable. */
export async function clearChat(cid = state.chatId) {
  if (!cid || state.streaming) return;
  const chat = state.project.chats.find(c => c.id === cid);
  if (!chat || !chat.messages.length) return; // nothing to clear
  if (!await confirmDialog('Clear this conversation? Its messages are removed — the chat, its model, and attachments stay.',
    { confirmLabel: 'Clear', danger: true })) return;
  try {
    await api(`/api/projects/${state.project.id}/chats/${cid}/messages`, { method: 'DELETE' });
  } catch (e) { toast(e.message, true); return; }
  chat.messages = [];
  if (cid === state.chatId) { renderMessages(); clearContext(); refreshContext(); $('#input').focus(); }
  toast('Conversation cleared');
}

/** Swap a chat's rail entry for an inline input; Enter/blur saves, Esc cancels. */
export function renameChat(cid) {
  const li = document.querySelector(`#chat-list li[data-id="${cid}"]`);
  const chat = state.project.chats.find(c => c.id === cid);
  if (!li || !chat) return;
  const input = document.createElement('input');
  input.className = 'chat-rename';
  input.value = chat.title;
  li.querySelector('span').replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const title = input.value.trim();
    if (title && title !== chat.title) {
      chat.title = title;
      await api(`/api/projects/${state.project.id}/chats/${cid}`, { method: 'PUT', body: { title } });
      if (cid === state.chatId) $('#chat-title').textContent = title;
    }
    renderChatList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit();
    else if (e.key === 'Escape') { done = true; renderChatList(); }
    e.stopPropagation();
  });
  input.addEventListener('blur', commit);
  input.addEventListener('click', (e) => e.stopPropagation());
}

export async function newChat() {
  const chat = await api(`/api/projects/${state.project.id}/chats`, {
    method: 'POST', body: { model: $('#model-select').value },
  });
  state.project.chats.unshift(chat);
  openChat(chat.id);
}

export function openChat(cid) {
  state.chatId = cid;
  clearContext(); // blank the meter now; refreshContext fills it for this chat
  const chat = currentChat();
  showView('chat');
  $('#chat-title').textContent = chat.title;
  $('#chat-project-name').textContent = state.project.name;
  if (chat.model) {
    const opt = [...$('#model-select').options].find(o => o.value === chat.model);
    if (opt) $('#model-select').value = chat.model;
  }
  updateRemoteBadge();
  renderChatList();
  renderMessages();
  /* A reply still streaming into this chat was detached by renderMessages
   * above — put the same node back. The closure in runExchange still holds
   * `body`, which is still this node's child, so it simply carries on
   * rendering where it left off. */
  if (state.streamChatId === cid && state.streamBubble) {
    const box = $('#messages');
    box.appendChild(state.streamBubble);
    box.scrollTop = box.scrollHeight;
  }
  updateStopTitle();
  renderChatAttachments();
  $('#inspector-tab').hidden = !$('#inspector').hidden; // tab shows when the panel is closed
  $('#input').focus();
  refreshContext();
}

export function renderMessages() {
  const chat = currentChat();
  const box = $('#messages');
  // data-idx maps a rendered bubble back to its raw message content — the
  // context menu's "Save as file…" needs the real markdown source, not the
  // rendered/uppercased-headings text a DOM read would give it.
  box.innerHTML = chat.messages.map((m, i) => m.role === 'user'
    ? `<div class="msg msg-user" data-idx="${i}"><div class="msg-role">You</div><div class="msg-body">${esc(m.content)}</div>${
        m.skillIds && m.skillIds.length ? `<div class="msg-skills">invoked: ${esc(skillNames(m.skillIds).join(', '))}</div>` : ''}</div>`
    : `<div class="msg msg-assistant" data-idx="${i}"><div class="msg-role">${esc(m.model || 'Model')}</div><div class="msg-body">${assistantBody(m)}</div>${toolsMeta(m.tools, m.toolNotes)}${usageMeta(m.usage)}</div>`
  ).join('');
  // retry lives on the conversation's final reply only
  const last = chat.messages[chat.messages.length - 1];
  if (last && last.role === 'assistant') addRetryButton(box.lastElementChild);
  box.scrollTop = box.scrollHeight;
  updateChatCost();
}

/** Scroll a specific message into view and briefly flash it — used by search
 *  to land you on the exact hit instead of just opening the chat at the top. */
export function scrollToMessage(idx) {
  const el = document.querySelector(`#messages .msg[data-idx="${idx}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center' });
  el.classList.add('msg-flash');
  setTimeout(() => el.classList.remove('msg-flash'), 1600);
}

export async function send(bypassOverflow = false) {
  if (state.streaming) return;
  const input = $('#input');
  const text = input.value.trim();
  if (!text || !state.project || !state.chatId) return;
  const model = $('#model-select').value;
  if (!model) { toast('No model available — pull one via Manage models, or add remote models in Preferences.', true); return; }

  // Overflow handling: if the request won't fit the context, either the server
  // can compact it (drop old history) or — if even the system prompt alone is
  // too big — we ask the user what to do. bypassOverflow skips this after they
  // pick a remedy.
  if (!bypassOverflow) {
    // make sure we have a token estimate before deciding — with a large
    // attachment the initial estimate can still be loading when Send is hit
    if (state.baseTokens == null) await refreshContext();
    if (willOverflow()) {
      if (cannotCompact(text)) { openOverflowDialog(text); return; }
      toast('This chat is long — older messages will be trimmed to fit the context.');
    }
  }

  const skillIds = [...state.invokedSkills];
  state.invokedSkills = [];
  renderSkillChips();
  input.value = '';
  input.style.height = 'auto';

  await runExchange(text, skillIds, model);
}

/**
 * Retry: re-run the last prompt. Pops the last exchange (trailing assistant
 * replies + the user message) on the server and resends the same text with
 * the same invoked skills — under whatever model is currently selected, so
 * switching models and hitting retry compares takes.
 */
export async function retryLast() {
  if (state.streaming || !state.project || !state.chatId) return;
  const cid = state.chatId;
  const chat = currentChat();
  if (!chat || !chat.messages.some(m => m.role === 'user')) return;
  const model = $('#model-select').value;
  if (!model) { toast('No model available — pull one via Manage models, or add remote models in Preferences.', true); return; }
  // Pre-check the one /chat rejection that happens before the server would
  // re-persist the popped message (remote model, no key) — otherwise a failed
  // retry would drop the turn from disk. Every other failure (overflow 413,
  // runner crash) occurs after /chat has already saved the user turn again.
  if (isRemoteModel(model) && !state.orConfigured) {
    toast('This model needs an OpenRouter key — add one in Preferences, or pick a local model.', true);
    return;
  }

  let removed;
  try {
    removed = await api(`/api/projects/${state.project.id}/chats/${cid}/messages/last`, { method: 'DELETE' });
  } catch (e) { toast(e.message, true); return; }

  chat.messages = removed.messages; // the server's trimmed truth — no mirror logic
  // the user may have switched chats while the pop was in flight — never
  // resend the prompt into whatever chat is now open. The popped turn is
  // already off the disk, so hand it back via the composer instead of
  // silently losing it.
  if (state.chatId !== cid) {
    $('#input').value = removed.message;
    toast('Chat changed mid-retry — your prompt is in the composer, unsent.');
    return;
  }
  renderMessages();
  await runExchange(removed.message, removed.skillIds || [], model);
}

/** Turn a past USER message into an inline edit box. Save truncates the
 *  chat to just before it and resends the new text — the same "edit &
 *  regenerate" idea as retry, generalized to any earlier message rather
 *  than only the last one. */
export function beginEditMessage(idx) {
  if (state.streaming) return;
  const chat = currentChat();
  const m = chat?.messages[idx];
  if (!m || m.role !== 'user') return;
  const li = document.querySelector(`#messages .msg[data-idx="${idx}"]`);
  if (!li) return;
  const body = li.querySelector('.msg-body');
  body.innerHTML = `
    <textarea class="msg-edit-box" rows="3">${esc(m.content)}</textarea>
    <div class="msg-edit-actions">
      <button class="btn btn-ghost msg-edit-cancel">Cancel</button>
      <button class="btn btn-primary msg-edit-save">Save &amp; resend</button>
    </div>`;
  const ta = body.querySelector('textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  body.querySelector('.msg-edit-cancel').addEventListener('click', () => renderMessages());
  body.querySelector('.msg-edit-save').addEventListener('click', () => submitEdit(idx, ta.value));
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitEdit(idx, ta.value); }
    else if (e.key === 'Escape') { e.preventDefault(); renderMessages(); }
  });
}

async function submitEdit(idx, newContent) {
  const text = newContent.trim();
  if (!text) { toast("Message can't be empty", true); return; }
  const chat = currentChat();
  const cid = state.chatId;
  const model = $('#model-select').value;
  if (!model) { toast('No model available — pull one via Manage models, or add remote models in Preferences.', true); return; }
  if (isRemoteModel(model) && !state.orConfigured) {
    toast('This model needs an OpenRouter key — add one in Preferences, or pick a local model.', true);
    return;
  }

  // editing message N discards it and everything after — its own reply is
  // expected (that's the whole point of editing), but discarding more than
  // that deserves a heads-up before it's gone
  const discarded = chat.messages.length - idx - 1;
  if (discarded > 1 && !await confirmDialog(
    `Editing this message will discard ${discarded} messages after it. Continue?`,
    { confirmLabel: 'Discard & resend', danger: true }
  )) { renderMessages(); return; }

  const skillIds = chat.messages[idx].skillIds || [];
  let trimmed;
  try {
    trimmed = await api(`/api/projects/${state.project.id}/chats/${cid}/messages/from/${idx}`, { method: 'DELETE' });
  } catch (e) { toast(e.message, true); renderMessages(); return; }

  chat.messages = trimmed.messages; // server truth, same pattern as retry
  if (state.chatId !== cid) {
    $('#input').value = text;
    toast('Chat changed mid-edit — your edited text is in the composer, unsent.');
    return;
  }
  renderMessages();
  await runExchange(text, skillIds, model);
}

const RETRY_BTN = '<button class="msg-retry" title="Retry — re-run your last prompt (with the currently selected model)">↻ retry</button>';

function addRetryButton(el) {
  el.insertAdjacentHTML('beforeend', RETRY_BTN);
  el.querySelector('.msg-retry').addEventListener('click', retryLast);
}

/** One full exchange: push the user turn, stream the reply, persist locally. */
async function runExchange(text, skillIds, model) {
  const chat = currentChat();
  /* This exchange belongs to the chat it was started in, for its whole life.
   * Everything below that touches the *view* is guarded on the open chat
   * still being this one — switching away used to leave the stream writing
   * into a bubble renderMessages() had already detached, then file the reply
   * into this chat's array while the Stop button sat in the new chat with
   * nothing to stop.
   *
   * Binding rather than aborting on switch, deliberately: the server persists
   * the full reply regardless of what this client does, so reading something
   * else while a long answer generates is a flow that already works. Aborting
   * would turn a finished reply into a truncated one to fix a display bug. */
  const cid = state.chatId;
  chat.messages.push({ role: 'user', content: text, skillIds });
  if (chat.title === 'New chat') { chat.title = text.slice(0, 60); $('#chat-title').textContent = chat.title; renderChatList(); }
  renderMessages();

  // live assistant bubble
  const box = $('#messages');
  const bubble = document.createElement('div');
  bubble.className = 'msg msg-assistant';
  bubble.innerHTML = `<div class="msg-role">${esc(model)}</div><div class="msg-body">${THINKING_DOTS}</div>`;
  box.appendChild(bubble);
  box.scrollTop = box.scrollHeight;
  const body = bubble.querySelector('.msg-body');

  setStreaming(true);
  state.abort = new AbortController();
  // so openChat can re-attach this bubble if the user comes back mid-stream
  state.streamChatId = cid;
  state.streamBubble = bubble;

  let acc = '';
  let accThink = '';
  let toolsUsed = [];
  let toolNotes = [];
  let stopped = false;
  let failure = null;
  let usage = null;
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: state.project.id, chatId: state.chatId, message: text, model, skillIds, options: state.project.options || {} }),
      signal: state.abort.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    let lastRender = 0;
    for await (const obj of readNdjson(res)) {
      if (obj.error) throw new Error(obj.error);
      if (obj.tools || obj.toolNotes) { toolsUsed = obj.tools || []; toolNotes = obj.toolNotes || []; }
      if (obj.message && obj.message.thinking) accThink += obj.message.thinking; // reasoning models
      if (obj.message && obj.message.content) acc += obj.message.content;
      if (obj.usage) usage = obj.usage;
      const now = performance.now();
      if (now - lastRender > 80) {  // throttle markdown re-render
        // the thinking block stays open while it's all we have, folds once the answer starts
        body.innerHTML = thinkingHtml(accThink, !acc) + (md(acc) || THINKING_DOTS);
        const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
        if (nearBottom) box.scrollTop = box.scrollHeight;
        lastRender = now;
      }
    }
    body.innerHTML = thinkingHtml(accThink) + (md(acc) || '<em>(empty response)</em>');
    // before the usage line, so the live order matches the re-rendered one
    bubble.insertAdjacentHTML('beforeend', toolsMeta(toolsUsed, toolNotes));
    if (usage) bubble.insertAdjacentHTML('beforeend', usageMeta(usage));
  } catch (e) {
    if (e.name === 'AbortError') {
      stopped = true;
      body.innerHTML = thinkingHtml(accThink) + md(acc) + '<p><em>— stopped —</em></p>';
    } else {
      failure = humanizeError(e.message, model);
      body.innerHTML = `<p style="color:var(--blood)">⚠ ${esc(failure)}</p>`;
    }
  }
  box.scrollTop = box.scrollHeight;
  setStreaming(false);
  const doneMsg = { role: 'assistant', content: acc, model };
  if (accThink) doneMsg.thinking = accThink;
  if (usage) doneMsg.usage = usage;
  if (toolsUsed.length) doneMsg.tools = toolsUsed;
  if (toolNotes.length) doneMsg.toolNotes = toolNotes;
  /* Mirror what the server just persisted, so switching away and back shows
   * the same thing as a reload does. The push is conditional now: an empty
   * successful reply used to create a bubble in memory that the server never
   * saved (its own guard is `if (acc)`), so it vanished on reload with no
   * explanation. */
  if (stopped && acc) doneMsg.stopped = true;
  if (failure) doneMsg.error = failure;
  if (acc || failure) chat.messages.push(doneMsg);
  chat.model = model;
  addRetryButton(bubble); // works after errors and Stop too — that's when you want it most
  state.streamChatId = null;
  state.streamBubble = null;
  // the meter and the cost readout describe the chat on screen — only repaint
  // them when that is still the chat this reply belongs to
  if (state.chatId === cid) {
    updateChatCost();
    refreshContext(); // history grew — re-estimate the base
  }
}
