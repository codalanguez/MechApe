/**
 * prefs.js — in-app Preferences panel.
 *
 * The Electron preload exposes `window.mechape`; when present, the gear in
 * the rail footer opens a modal with three storage locations — projects &
 * chats, skills, and downloaded models — each restarting the server and
 * reloading the UI on change.
 * Each can be overridden by its env var, in which case it renders read-only.
 * In plain browser mode the global is absent and those sections hide (see
 * the `.prefs-desktop` sweep below) — but Data & backup works in both modes,
 * since a repo checkout has projects worth backing up too.
 */
import { $, esc, toast, fmtBytes } from './util.js';
import { api } from './api.js';
import { initModal } from './modal.js';
import { confirmDialog } from './confirm.js';
import { openBrowser } from './filebrowser.js';
import { state } from './state.js';
import { showProjectsPage } from './projects.js';

const bridge = window.mechape;
const WIPE_PHRASE = 'ERASE EVERYTHING';

function renderLocation(pathElId, noteElId, buttonIds, value, envValue) {
  $(pathElId).textContent = envValue || value;
  $(noteElId).hidden = !envValue;
  for (const id of buttonIds) $(id).disabled = Boolean(envValue);
}

function render(prefs) {
  renderLocation('#prefs-data-dir', '#prefs-data-env-note',
    ['#btn-prefs-choose-data', '#btn-prefs-default-data'],
    prefs.dataDir + (prefs.dataDirCustom ? '' : '  (default)'), prefs.dataDirEnv);

  renderLocation('#prefs-skills-dir', '#prefs-skills-env-note',
    ['#btn-prefs-choose-skills', '#btn-prefs-default-skills'],
    prefs.skillsDir + (prefs.skillsDirCustom ? '' : '  (default)'), prefs.skillsDirEnv);

  renderLocation('#prefs-models-dir', '#prefs-models-env-note',
    ['#btn-prefs-choose-models', '#btn-prefs-default-models'],
    prefs.modelsDir + (prefs.modelsDirCustom ? '' : '  (default)'), prefs.modelsDirEnv);

  renderGpu(prefs);

  renderFsAccess(prefs);

  renderOpenRouter(prefs);
}

/** GPU build: what's running now, plus the CUDA opt-in (Windows only). */
function renderGpu(prefs) {
  const section = $('#prefs-cuda-section');
  section.hidden = !prefs.cudaAvailable;
  if (!prefs.cudaAvailable) return;
  $('#prefs-use-cuda').checked = Boolean(prefs.useCuda);
  // the live accelerator comes from the health endpoint, not preferences —
  // it reflects what actually loaded, including a fallback to CPU
  const el = $('#prefs-accel-current');
  el.textContent = 'Checking…';
  api('/api/health')
    .then(h => { el.textContent = h.ok && h.accel ? `Currently running on: ${h.accel}` : 'Local backend not running'; })
    .catch(() => { el.textContent = ''; });
}

// generation counter for the async budget box — a slow response from a
// previous Preferences open must never overwrite a newer render
let keyStatusGen = 0;

// whether a key is currently saved — the Save button uses this to ask
// before replacing an existing key
let orKeySaved = false;

/** OpenRouter key status: the key is write-only, so all we render is whether
 * one exists and where it came from — plus a live credits readout. */
function renderOpenRouter(prefs) {
  $('#prefs-or-status').textContent = prefs.openrouterConfigured
    ? 'Key saved — remote models are available in the model picker.'
    : prefs.openrouterKeyLost
      // an upgrade that renamed the app leaves the saved key unreadable. Say
      // that plainly: "no key" would read as a setting the user never made.
      ? 'Your saved key could not be read after the app was updated — paste it again below to restore remote models.'
      : 'No key — MechApe is fully local.';
  $('#prefs-or-status').classList.toggle('prefs-warn', Boolean(prefs.openrouterKeyLost) && !prefs.openrouterConfigured);
  $('#prefs-or-env-note').hidden = !prefs.openrouterKeyEnv;
  for (const id of ['#prefs-or-key', '#btn-prefs-or-save', '#btn-prefs-or-clear'])
    $(id).disabled = Boolean(prefs.openrouterKeyEnv);
  $('#btn-prefs-or-clear').hidden = !prefs.openrouterConfigured || prefs.openrouterKeyEnv;

  // privacy routing toggle (checked = allow logging providers)
  $('#prefs-or-logging').checked = prefs.orDataCollection === 'allow';
  $('#prefs-or-logging').disabled = Boolean(prefs.orDataCollectionEnv);
  $('#prefs-or-logging-env-note').hidden = !prefs.orDataCollectionEnv;

  // live budget + spend, in its own box, filled once the (async) check
  // returns. The generation counter keeps a slow response from a previous
  // open from overwriting a newer render.
  orKeySaved = Boolean(prefs.openrouterConfigured);
  const budget = $('#prefs-or-budget');
  budget.hidden = true;
  budget.textContent = '';
  if (prefs.openrouterConfigured) {
    const gen = ++keyStatusGen;
    api('/api/openrouter/key-status').then(k => {
      if (gen !== keyStatusGen) return; // a newer render superseded this fetch
      const parts = [];
      // the account balance is the number that matters — lead with it
      if (k.credits) parts.push(`$${k.credits.remaining.toFixed(2)} remaining of $${k.credits.totalCredits.toFixed(2)} loaded`);
      if (k.usage != null) parts.push(`$${k.usage.toFixed(2)} used by this key${k.limit != null ? ` (cap $${k.limit.toFixed(2)})` : ''}`);
      if (k.isFreeTier) parts.push('free tier');
      if (parts.length) { budget.textContent = parts.join(' · '); budget.hidden = false; }
    }).catch(() => { /* offline — the box stays hidden */ });
  }
}

/** The file-access allowlist: whole-disk banner, or a removable list of folders. */
function renderFsAccess(prefs) {
  const env = prefs.fsRootsEnv;
  $('#prefs-fs-env-note').hidden = !env;
  for (const id of ['#btn-prefs-fs-add', '#btn-prefs-fs-all', '#btn-prefs-fs-home']) $(id).disabled = Boolean(env);

  const summary = $('#prefs-fs-summary');
  const list = $('#prefs-fs-list');
  if (prefs.fsWholeDisk) {
    summary.textContent = 'Whole disk — MechApe can read anywhere on this computer.';
    list.innerHTML = '';
    return;
  }
  const roots = prefs.fsRoots || [];
  summary.textContent = (roots.length === 1 && roots[0] === prefs.fsHome)
    ? 'Your home folder only (default)'
    : `${roots.length} allowed folder${roots.length === 1 ? '' : 's'}`;
  list.innerHTML = roots.map(r => `
    <li><span class="att-path" title="${esc(r)}">${esc(r)}</span>${
      env ? '' : `<button data-fsroot="${encodeURIComponent(r)}" title="Remove">×</button>`}</li>`).join('');
  if (!env) list.querySelectorAll('[data-fsroot]').forEach(b =>
    b.addEventListener('click', async () => {
      const next = await bridge.removeFsRoot(decodeURIComponent(b.dataset.fsroot));
      if (next) render(next);
    }));
}

/* ---- Data & backup (works in browser mode too, not just the desktop shell) ---- */

/** Fetch and render the project/embedding-cache summary shown above the
 *  backup/wipe buttons. Fire-and-forget from the panel's open handler. */
async function loadDataSummary() {
  const el = $('#prefs-data-summary');
  try {
    const info = await api('/api/backup/info');
    const projects = `${info.projectCount} project${info.projectCount === 1 ? '' : 's'}`;
    el.textContent = `${projects} · ${info.dataDir}${info.embedBytes ? ` · embeddings cache: ${fmtBytes(info.embedBytes)}` : ''}`;
  } catch { el.textContent = 'Could not read data folder'; }
}

/* Data/skills changes restart the server and reload the page, so the toast
 * only shows if the call returns without a reload (cancel or env-locked). */
function wireAction(btnId, call, msg) {
  $(btnId).addEventListener('click', async () => {
    const prefs = await call();
    if (!prefs) return; // picker canceled
    render(prefs);
    if (msg) toast(msg);
  });
}

/* ---- theme (works in desktop AND browser mode — purely client-side) ---- */

const THEME_KEY = 'mechape.theme'; // keep in sync with js/theme-boot.js
const savedTheme = () => { try { return localStorage.getItem(THEME_KEY) || 'cyber-deco'; } catch { return 'cyber-deco'; } };

function applyTheme(t) {
  if (t && t !== 'cyber-deco') document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  try { localStorage.setItem(THEME_KEY, t); } catch { /* storage disabled */ }
}

export function initPrefs() {
  const modal = initModal('#prefs-backdrop', '#btn-close-prefs');
  $('#btn-prefs').hidden = false;

  const themeSel = $('#prefs-theme');
  themeSel.value = savedTheme();
  themeSel.addEventListener('change', () => applyTheme(themeSel.value));

  $('#btn-prefs').addEventListener('click', async () => {
    themeSel.value = savedTheme();
    if (bridge) render(await bridge.getPrefs());
    loadDataSummary();
    modal.open();
  });

  $('#btn-prefs-backup').addEventListener('click', () => {
    openBrowser({
      title: 'Back up to…',
      verb: 'back up here',
      dirLabel: 'Back up here',
      dirsOnly: true,
      onPick: async (dir) => {
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 16);
        try {
          const res = await api('/api/backup', { method: 'POST', body: { dir, filename: `mechape-backup-${stamp}.zip` } });
          toast(`Backed up ${res.projects} project${res.projects === 1 ? '' : 's'} to ${res.path}`);
        } catch (e) { toast(e.message, true); }
      },
    });
  });

  $('#btn-prefs-wipe').addEventListener('click', async () => {
    const ok = await confirmDialog(
      'Erase ALL projects, chats, and cached embeddings? Skills and these preferences are untouched. ' +
      'This cannot be undone — back up first if you want to keep anything.',
      { confirmLabel: 'Erase everything', danger: true, requireText: WIPE_PHRASE });
    if (!ok) return;
    try {
      const res = await api('/api/wipe', { method: 'POST', body: { confirm: WIPE_PHRASE } });
      state.project = null;
      state.chatId = null;
      $('#chat-section').hidden = true;
      $('#inspector').hidden = true;
      await showProjectsPage();
      loadDataSummary();
      toast(`Erased ${res.projects} project${res.projects === 1 ? '' : 's'} and ${res.embeddings} cached embedding${res.embeddings === 1 ? '' : 's'}`);
    } catch (e) { toast(e.message, true); }
  });

  if (!bridge) {
    // browser mode: no desktop shell to configure — only theme + backup/wipe apply
    document.querySelectorAll('#prefs-backdrop .prefs-desktop').forEach(el => { el.hidden = true; });
    return;
  }

  $('#btn-prefs-open-data').addEventListener('click', () => bridge.openDataFolder());

  wireAction('#btn-prefs-choose-data', () => bridge.chooseDataDir());
  wireAction('#btn-prefs-default-data', () => bridge.resetDataDir());
  wireAction('#btn-prefs-choose-skills', () => bridge.chooseSkillsDir());
  wireAction('#btn-prefs-default-skills', () => bridge.resetSkillsDir());
  wireAction('#btn-prefs-choose-models', () => bridge.chooseModelsDir());
  wireAction('#btn-prefs-default-models', () => bridge.resetModelsDir());

  $('#prefs-use-cuda').addEventListener('change', async (e) => {
    const next = await bridge.setUseCuda(e.target.checked);
    if (next) {
      render(next);
      toast(e.target.checked
        ? 'CUDA enabled — it downloads (~640 MB) the next time you start MechApe'
        : 'Staying on the bundled Vulkan build — applies the next time you start MechApe');
    }
  });

  wireAction('#btn-prefs-fs-add', () => bridge.addFsRoot());
  wireAction('#btn-prefs-fs-all', () => bridge.fsWholeDisk());
  wireAction('#btn-prefs-fs-home', () => bridge.fsResetHome());

  // OpenRouter key: sent one-way to the main process (encrypted at rest),
  // input cleared immediately either way
  $('#btn-prefs-or-save').addEventListener('click', async () => {
    const key = $('#prefs-or-key').value.trim();
    if (!key) { toast('Paste an OpenRouter API key first', true); return; }
    // a key is already saved — replacing it should be a decision, not a slip
    if (orKeySaved && !await confirmDialog(
      'Replace the saved OpenRouter key with this new one? The old key stays valid at openrouter.ai — this only changes which key MechApe uses.',
      { confirmLabel: 'Replace key' })) return;
    $('#prefs-or-key').value = '';
    try {
      const prefs = await bridge.setOpenRouterKey(key);
      if (prefs) { render(prefs); toast('OpenRouter key saved'); }
    } catch { toast('Could not save the key (OS encryption unavailable)', true); }
  });
  $('#btn-prefs-or-clear').addEventListener('click', async () => {
    const prefs = await bridge.setOpenRouterKey('');
    if (prefs) { render(prefs); toast('OpenRouter key removed — fully local again'); }
  });

  // privacy routing: restarts the server (config reads the flag at boot)
  $('#prefs-or-logging').addEventListener('change', (e) => bridge.setOrLogging(e.target.checked));
}
