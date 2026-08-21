/**
 * memory.js — Preferences → Memory: read and erase what MechApe remembers.
 *
 * Cross-chat memory is on by default, extracted after every local reply, and
 * injected into every later local prompt. lib/memory.js argues that this is
 * acceptable *because* the facts are readable and deletable — and the read
 * and delete endpoints have existed all along. What did not exist was any way
 * to reach them without hand-writing HTTP, which left the module's own stated
 * justification true of the API and false of the product.
 *
 * Deliberately not a `.prefs-desktop` section: these endpoints are served by
 * the local server, so they work identically under `npm start`, and the
 * desktop-only sweep in prefs.js would otherwise hide the feature from
 * exactly the users who have no other way to reach it.
 */
import { $, esc, toast } from './util.js';
import { api } from './api.js';
import { confirmDialog } from './confirm.js';

/* A slow response from a previous open must not overwrite a newer render —
 * the same generation-counter guard the OpenRouter budget box uses. */
let gen = 0;

/** Fetch and render the current memory. Safe to call whenever it may have changed. */
export async function loadMemory() {
  const mine = ++gen;
  const summary = $('#prefs-memory-summary');
  const list = $('#prefs-memory-list');
  let data;
  try {
    data = await api('/api/memory');
  } catch {
    if (mine !== gen) return;
    summary.textContent = 'Could not read memory.';
    list.innerHTML = '';
    return;
  }
  if (mine !== gen) return;

  const facts = data.facts || [];
  summary.textContent = data.enabled
    ? `${facts.length} of ${data.max} remembered · ${data.file}`
    : `Memory is off — nothing new is being recorded. ${facts.length} fact${facts.length === 1 ? '' : 's'} already stored.`;

  $('#btn-prefs-memory-forget-all').disabled = facts.length === 0;

  if (!facts.length) {
    // Say where facts come from, not just that there are none: "remote chats
    // are skipped" is the part a privacy-minded reader actually wants.
    list.innerHTML = '<li class="empty">Nothing remembered yet. Facts are only extracted from chats with local models — remote ones are skipped.</li>';
    return;
  }

  list.innerHTML = facts.map(f => `
    <li>
      <span class="mem-text" title="${esc(f.text)}">${esc(f.text)}</span>
      <button data-forget="${esc(f.id)}" title="Forget this">×</button>
    </li>`).join('');

  list.querySelectorAll('[data-forget]').forEach(b => b.addEventListener('click', async () => {
    // No confirmation for one fact: it is a single sentence, and the whole
    // point of this panel is that taking something back should be easy.
    try {
      await api(`/api/memory/${encodeURIComponent(b.dataset.forget)}`, { method: 'DELETE' });
      loadMemory();
    } catch (e) { toast(e.message, true); }
  }));
}

/* ---- integrations (MCP) ----
 *
 * Lives here rather than in its own module because it is the same shape of
 * thing: a server-side list the user needs to be able to see, in a panel
 * that works in both desktop and browser mode.
 *
 * The reason it needs to exist at all: a server that fails to start was
 * logged, and reported back by /api/integrations to a caller that did not
 * exist. In the chat the only symptom was a model that never used its tools
 * — indistinguishable from a model that cannot call them, a typo in the
 * config, or the feature not being there. */

export async function loadIntegrations() {
  const summary = $('#prefs-mcp-summary');
  const list = $('#prefs-mcp-list');
  let data;
  try {
    data = await api('/api/integrations');
  } catch {
    summary.textContent = 'Could not read integrations.';
    list.innerHTML = '';
    return;
  }
  const servers = data.servers || [];
  $('#btn-prefs-mcp-reload').disabled = !data.configured;

  if (!data.configured) {
    summary.textContent = `No integrations configured · ${data.configPath}`;
    list.innerHTML = '<li class="empty">Write that file to connect an MCP server. Nothing runs until you do.</li>';
    return;
  }
  const up = servers.filter(s => s.connected).length;
  summary.textContent = `${up} of ${servers.length} connected · ${data.configPath}`;
  list.innerHTML = servers.map(s => `
    <li>
      <span class="att-path" title="${esc(s.name)}">${esc(s.name)}</span>
      <span class="mcp-state ${s.connected ? 'on' : 'off'}">${
  s.connected ? `${s.tools.length} tool${s.tools.length === 1 ? '' : 's'}` : 'failed'}</span>
    </li>`).join('');
}

export function initIntegrations() {
  $('#btn-prefs-mcp-reload').addEventListener('click', async () => {
    $('#prefs-mcp-summary').textContent = 'Reconnecting…';
    try {
      const res = await api('/api/integrations/reload', { method: 'POST' });
      // A failure here is the whole point of the panel — name the server and
      // the reason, and keep it on screen rather than in a toast that expires.
      if (res.failures && res.failures.length) {
        toast(`${res.failures[0].server}: ${res.failures[0].error}`, true);
      } else {
        toast('Integrations reconnected');
      }
    } catch (e) { toast(e.message, true); }
    loadIntegrations();
  });
}

export function initMemory() {
  $('#btn-prefs-memory-forget-all').addEventListener('click', async () => {
    const n = $('#prefs-memory-list').querySelectorAll('[data-forget]').length;
    const ok = await confirmDialog(
      `Forget all ${n} remembered fact${n === 1 ? '' : 's'}? Your chats are untouched — this only clears what was distilled out of them.`,
      { confirmLabel: 'Forget everything', danger: true });
    if (!ok) return;
    try {
      await api('/api/memory', { method: 'DELETE' });
      toast('Memory cleared');
      loadMemory();
    } catch (e) { toast(e.message, true); }
  });
}
