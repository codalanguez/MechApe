/**
 * openrouter.js — remote-model UI: the browse/favorites dialog.
 *
 * All remote UI stays hidden until the server reports an API key is
 * configured (the key itself never reaches the browser). The dialog lists
 * OpenRouter's catalog with context length and $/M-token pricing; starring
 * a model adds it to the header picker as "openrouter:<id>". Favorites are
 * stored locally as {id, name, contextLength} so the picker renders them
 * without needing the catalog fetched first.
 */
import { $, esc, fmtCtx, fmtPerM } from './util.js';
import { api } from './api.js';
import { state } from './state.js';
import { initModal } from './modal.js';
import { loadModels } from './status.js';

/* Single source of truth for the remote-model namespace on the frontend
 * (mirrors PREFIX in lib/openrouter.js — the chat.model values on disk). */
export const OR_PREFIX = 'openrouter:';
export const isRemoteModel = (name) => typeof name === 'string' && name.startsWith(OR_PREFIX);

const FAV_KEY = 'mechape.orFavorites';

export function orFavorites() {
  try { return JSON.parse(localStorage.getItem(FAV_KEY)) || []; } catch { return []; }
}
const saveFavorites = (f) => localStorage.setItem(FAV_KEY, JSON.stringify(f));

/** Ask the server whether a key exists; toggles all remote UI. */
export async function refreshOrStatus() {
  try { state.orConfigured = (await api('/api/openrouter/status')).configured; }
  catch { state.orConfigured = false; }
  $('#btn-or-browse').hidden = !state.orConfigured;
  return state.orConfigured;
}

/* ---- browse dialog ---- */


/* Sorts the catalog offers. Favourites always float to the top regardless —
 * they are the models this user already chose, and burying them under a
 * ranking would make starring one feel like losing it.
 *
 * A model with no published score sorts last within its group rather than as
 * a zero: about half the catalog carries no benchmarks, and treating
 * "unmeasured" as "scored nothing" would quietly libel them. */
const SORTS = {
  name: (a, b) => a.id.localeCompare(b.id),
  coding: (a, b) => byScoreDesc(a.coding, b.coding) || a.id.localeCompare(b.id),
  intelligence: (a, b) => byScoreDesc(a.intelligence, b.intelligence) || a.id.localeCompare(b.id),
  agentic: (a, b) => byScoreDesc(a.agentic, b.agentic) || a.id.localeCompare(b.id),
  cheap: (a, b) => (a.promptPrice ?? Infinity) - (b.promptPrice ?? Infinity) || a.id.localeCompare(b.id),
  context: (a, b) => (b.contextLength || 0) - (a.contextLength || 0) || a.id.localeCompare(b.id),
};

function byScoreDesc(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return 1;          // unrated sinks, but only against a rated peer
  if (b == null) return -1;
  return b - a;
}

/* Which sorts rank on a published number — and so which ones owe the reader
 * the number they are being ranked by. */
const SCORE_KEYS = { coding: 'coding', intelligence: 'intelligence', agentic: 'agentic' };

/** Capability tags for one row, plus the score the current sort is ranking on. */
function rowTags(m, sortKey) {
  const tags = [];
  if (m.vision) tags.push('<span class="or-tag">vision</span>');
  if (m.tools) tags.push('<span class="or-tag">tools</span>');
  if (m.reasoning) tags.push('<span class="or-tag">reasoning</span>');
  // Show the number being sorted on, so a ranked list explains its own order
  // — and says "unrated" outright rather than leaving a gap that reads as a
  // bad score.
  if (SCORE_KEYS[sortKey]) {
    const v = m[sortKey];
    tags.push(`<span class="or-tag score">${SCORE_KEYS[sortKey]} ${v == null ? 'unrated' : Math.round(v)}</span>`);
  }
  return tags.length ? `<div class="or-tags">${tags.join('')}</div>` : '';
}

function renderList() {
  const q = $('#or-search').value.trim().toLowerCase();
  const freeOnly = $('#or-free-only').checked;
  const needVision = $('#or-vision').checked;
  const needTools = $('#or-tools').checked;
  const needReasoning = $('#or-reasoning').checked;
  const sortKey = $('#or-sort').value;
  const favs = orFavorites();
  const isFav = (id) => favs.some(f => f.id === id);
  const matched = (state.orCatalog || [])
    .filter(m => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q)
      || (m.description || '').toLowerCase().includes(q))
    .filter(m => !freeOnly || (m.promptPrice === 0 && m.completionPrice === 0))
    .filter(m => !needVision || m.vision)
    .filter(m => !needTools || m.tools)
    .filter(m => !needReasoning || m.reasoning);

  const order = SORTS[sortKey] || SORTS.name;
  const rows = matched
    .sort((a, b) => (isFav(b.id) - isFav(a.id)) || order(a, b))
    .slice(0, 250);

  // The list is capped, so say what the cap is hiding rather than letting a
  // filter look like it found nothing more.
  const total = (state.orCatalog || []).length;
  $('#or-count').textContent = matched.length === total
    ? `${total} models`
    : `${matched.length} of ${total}${matched.length > rows.length ? ` · showing ${rows.length}` : ''}`;

  $('#or-list').innerHTML = rows.length ? rows.map(m => `
    <li>
      <button class="or-star ${isFav(m.id) ? 'faved' : ''}" data-id="${esc(m.id)}"
        title="${isFav(m.id) ? 'Remove from your model picker' : 'Add to your model picker'}">${isFav(m.id) ? '★' : '☆'}</button>
      <div class="or-meta">
        <div class="or-name">${esc(m.name)}</div>
        <div class="or-id">${esc(m.id)}</div>
        ${rowTags(m, sortKey)}
        ${m.description ? `<div class="or-desc">${esc(m.description)}</div>` : ''}
      </div>
      <div class="or-specs">${fmtCtx(m.contextLength, '—')} ctx · ${fmtPerM(m.promptPrice)} in / ${fmtPerM(m.completionPrice)} out <span class="or-perm">per M tokens</span></div>
    </li>`).join('')
    : '<li class="empty">No models match.</li>';

  $('#or-list').querySelectorAll('.or-star').forEach(b => b.addEventListener('click', () => toggleFav(b.dataset.id)));
}

function toggleFav(id) {
  const favs = orFavorites();
  const i = favs.findIndex(f => f.id === id);
  if (i >= 0) favs.splice(i, 1);
  else {
    const m = (state.orCatalog || []).find(x => x.id === id) || {};
    // keep enough metadata (incl. prices) for the picker and info box to
    // render without needing the catalog fetched first
    favs.push({
      id, name: m.name || id, contextLength: m.contextLength || null,
      promptPrice: m.promptPrice ?? null, completionPrice: m.completionPrice ?? null,
    });
  }
  saveFavorites(favs);
  renderList();
  loadModels(); // picker reflects stars immediately
}

async function loadCatalog() {
  const list = $('#or-list');
  if (!state.orCatalog) {
    list.innerHTML = '<li class="empty">Loading the OpenRouter catalog…</li>';
    try { state.orCatalog = (await api('/api/openrouter/models')).models; }
    catch (e) { list.innerHTML = `<li class="empty">${esc(e.message)}</li>`; return; }
  }
  renderList();
  showBalance();
}

/** Remaining account budget in the dialog hint — you're about to spend it. */
async function showBalance() {
  $('#or-balance').textContent = ''; // never let a previous balance linger
  try {
    const k = await api('/api/openrouter/key-status'); // server caches 60s
    if (k.credits) {
      $('#or-balance').textContent = `· $${k.credits.remaining.toFixed(2)} remaining on your account`;
    }
  } catch { /* offline — hint stays plain */ }
}

export function initOpenRouter() {
  initModal('#or-backdrop', '#btn-close-or');
  $('#btn-or-browse').addEventListener('click', () => { $('#or-backdrop').hidden = false; $('#or-search').focus(); loadCatalog(); });
  $('#or-search').addEventListener('input', renderList);
  for (const id of ['#or-free-only', '#or-vision', '#or-tools', '#or-reasoning', '#or-sort']) {
    $(id).addEventListener('change', renderList);
  }
}
