/**
 * model-manager.js — pull, delete, and see disk usage for local models.
 *
 * A modal (opened from Model settings or the desktop menu) that lists the
 * installed .gguf files with sizes and a running total, deletes one on
 * request, and pulls a new one — given a Hugging Face repo (optionally
 * "owner/repo:QUANT") — while streaming its download progress into a bar.
 * After any change it refreshes both the header model picker and its own list
 * so the rest of the app sees new/removed models immediately.
 */
import { $, esc, toast, fmtBytes, readNdjson } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { confirmDialog } from './confirm.js';
import { loadModels } from './status.js';

const fmtSize = (n) => fmtBytes(n, '—');

async function renderList() {
  const ul = $('#mm-list');
  try {
    const { models } = await api('/api/models');
    state.models = models;
    const total = models.reduce((s, m) => s + (m.size || 0), 0);
    $('#mm-total').textContent = models.length
      ? `${models.length} model${models.length === 1 ? '' : 's'} · ${fmtSize(total)} on disk`
      : '';
    ul.innerHTML = models.length
      ? models.map(m => `
        <li>
          <div class="mm-name">${esc(m.name)}</div>
          <div class="mm-size">${fmtSize(m.size)}</div>
          <button class="mm-del" data-model="${esc(m.name)}" title="Delete this model">Delete</button>
        </li>`).join('')
      : '<li class="empty">No models installed. Pull one above (e.g. bartowski/Llama-3.2-3B-Instruct-GGUF).</li>';
    ul.querySelectorAll('.mm-del').forEach(b => b.addEventListener('click', () => del(b.dataset.model)));
  } catch { ul.innerHTML = '<li class="empty">The local model backend is not reachable.</li>'; }
}

async function del(name) {
  if (!await confirmDialog(`Delete model "${name}"? This frees its disk space and cannot be undone.`,
    { confirmLabel: 'Delete', danger: true })) return;
  try {
    await api(`/api/models?name=${encodeURIComponent(name)}`, { method: 'DELETE' });
    toast(`Deleted ${name}`);
    await renderList();
    await loadModels();
  } catch (e) { toast(e.message, true); }
}

async function pull() {
  const name = $('#mm-pull-name').value.trim();
  if (!name) { toast('Enter a Hugging Face repo to pull (e.g. owner/repo or owner/repo:Q4_K_M)', true); return; }

  const btn = $('#btn-mm-pull');
  const progress = $('#mm-progress');
  const fill = $('#mm-bar-fill');
  const text = $('#mm-progress-text');
  btn.disabled = true;
  btn.textContent = 'Pulling…';
  progress.hidden = false;
  fill.style.width = '0%';
  text.textContent = 'starting…';

  try {
    const res = await fetch('/api/models/pull', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);

    for await (const o of readNdjson(res)) {
      if (o.error) throw new Error(o.error);
      if (o.total && o.completed != null) {
        const pct = Math.min(100, Math.round((o.completed / o.total) * 100));
        fill.style.width = pct + '%';
        text.textContent = `${o.status || 'downloading'} · ${pct}%`;
      } else if (o.status) {
        text.textContent = o.status;
      }
    }
    fill.style.width = '100%';
    text.textContent = 'done';
    toast(`Pulled ${name}`);
    $('#mm-pull-name').value = '';
    await renderList();
    await loadModels();
  } catch (e) {
    text.textContent = `failed: ${e.message}`;
    toast(`Pull failed: ${e.message}`, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Pull';
    setTimeout(() => { progress.hidden = true; }, 1500);
  }
}

export function openModelManager() {
  renderList();
  $('#model-manager-backdrop').hidden = false;
}

export function initModelManager() {
  $('#btn-mm-pull').addEventListener('click', pull);
  $('#mm-pull-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') pull(); });
}
