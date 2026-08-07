/**
 * prefs-ipc.js — the Preferences panel's IPC surface.
 *
 * The web UI reaches these through the preload bridge (window.mechape).
 * Every handler validates that the call originates from the app's own pages:
 * if the renderer were ever tricked into showing foreign content, that page
 * must not be able to reach the folder pickers or settings.
 *
 * Data & skills changes restart the forked server (it reads config once at
 * boot) and rebuild the menu, whose folder shortcuts reflect the new paths.
 */
const { ipcMain, dialog, shell } = require('electron');
const os = require('os');
const runtime = require('./runtime');
const { env, loadSettings, saveSettings, effectiveStorage, fsRootsList, fsWholeDisk, setOpenRouterKey, openrouterConfigured, orDataCollection } = require('./settings');
const { pickFolder } = require('./dialogs');
const { restartServer } = require('./server');
const { buildMenu } = require('./menu');

/* What the panel sees. For each location: the effective path, whether it
 * came from a user pick, and the env var that (when set) always wins over
 * the saved setting — shown read-only in the UI. */
function prefsSummary() {
  const s = loadSettings();
  const eff = effectiveStorage();
  return {
    dataDir: eff.dataDir,
    dataDirCustom: Boolean(s.dataDir),
    dataDirEnv: env('DATA_DIR') || null,
    skillsDir: eff.skillsDir,
    skillsDirCustom: Boolean(s.skillsDir),
    skillsDirEnv: env('SKILLS_DIR') || null,
    modelsDir: eff.modelsDir,
    modelsDirCustom: Boolean(s.modelsDir),
    modelsDirEnv: env('MODELS_DIR') || null,
    // CUDA is the default where an NVIDIA card is present, so the control is
    // an opt-*out*. Windows only — the other platforms have no choice to
    // make. Takes effect on the next launch, since the backend build is
    // resolved once at boot.
    useCuda: !s.cudaOptOut,
    cudaAvailable: process.platform === 'win32',
    // file-access allowlist
    fsRoots: fsRootsList(),
    fsWholeDisk: fsWholeDisk(),
    fsHome: os.homedir(),
    fsRootsEnv: env('FS_ROOTS') ?? null,
    // remote backend: only whether a key exists — the key itself never
    // crosses into the renderer
    openrouterConfigured: openrouterConfigured(),
    openrouterKeyEnv: env('OPENROUTER_KEY') !== undefined,
    orDataCollection: orDataCollection(),
    orDataCollectionEnv: env('OR_DATA_COLLECTION') !== undefined,
  };
}

/** ipcMain.handle, but only for calls from our own UI. */
function handleUI(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!runtime.isAppUrl(event.senderFrame?.url || '')) throw new Error('unauthorized sender');
    return fn(...args);
  });
}

/**
 * First-run offer to download the embedding model that powers offline
 * large-attachment search. Returns 'download' | 'later' | 'dismissed'.
 * "Don't ask again" is remembered so we never nag.
 */
async function promptEmbedModel({ recommended, size } = {}) {
  if (loadSettings().dismissedEmbedPrompt) return 'dismissed';
  const model = recommended || 'nomic-ai/nomic-embed-text-v1.5-GGUF:Q4_K_M';
  const { response, checkboxChecked } = await dialog.showMessageBox(runtime.win, {
    type: 'question',
    title: 'MechApe — offline attachment search',
    message: 'Enable searching large attachments?',
    detail: `MechApe can embed big attachments (a whole manuscript or codebase) on your machine, so only the passages relevant to your question go into each prompt — entirely offline. ` +
      `It needs a small embedding model, ${model}${size ? ` (~${size})` : ''}, downloaded once from Hugging Face.\n\n` +
      `Without it, large attachments still work — they're just truncated to fit the context.`,
    buttons: ['Download', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: "Don't ask again",
    checkboxChecked: false,
    noLink: true,
  });
  if (checkboxChecked) saveSettings({ dismissedEmbedPrompt: true });
  return response === 0 ? 'download' : 'later';
}

/**
 * First-run offer to download a small default chat model so a clean install can
 * chat right away. Returns 'download' | 'later' | 'dismissed'; "Don't ask again"
 * is remembered.
 */
async function promptChatModel({ recommended, size } = {}) {
  if (loadSettings().dismissedChatPrompt) return 'dismissed';
  const model = recommended || 'bartowski/Llama-3.2-3B-Instruct-GGUF:Q4_K_M';
  const { response, checkboxChecked } = await dialog.showMessageBox(runtime.win, {
    type: 'question',
    title: 'MechApe — get started',
    message: 'Download a model to chat with?',
    detail: `MechApe runs models locally via its own llama.cpp backend, and none are installed yet. ` +
      `Download a small, capable default — ${model}${size ? ` (${size})` : ''} — to start chatting right away? ` +
      `You can pull other models any time from Manage models.`,
    buttons: ['Download', 'Not now'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: "Don't ask again",
    checkboxChecked: false,
    noLink: true,
  });
  if (checkboxChecked) saveSettings({ dismissedChatPrompt: true });
  return response === 0 ? 'download' : 'later';
}

/** Save a storage patch, restart the server on it, refresh dependent UI. */
async function applyStorageChange(patch) {
  saveSettings(patch);
  await restartServer();
  await buildMenu();
  return prefsSummary();
}

function registerPrefsIpc() {
  handleUI('prefs:get', () => prefsSummary());

  handleUI('prefs:choose-models-dir', async () => {
    const p = await pickFolder('Select the folder for downloaded models');
    return p ? applyStorageChange({ modelsDir: p }) : null;
  });

  handleUI('prefs:reset-models-dir', () => applyStorageChange({ modelsDir: undefined }));

  handleUI('prefs:choose-data-dir', async () => {
    const p = await pickFolder('Select the folder for projects & chats');
    return p ? applyStorageChange({ dataDir: p }) : null;
  });

  handleUI('prefs:reset-data-dir', () => applyStorageChange({ dataDir: undefined }));

  handleUI('prefs:choose-skills-dir', async () => {
    const p = await pickFolder('Select your skills folder');
    return p ? applyStorageChange({ skillsDir: p }) : null;
  });

  handleUI('prefs:reset-skills-dir', () => applyStorageChange({ skillsDir: undefined }));

  // file-access allowlist — each change restarts the server (config reads it at boot)
  handleUI('prefs:fs-add-root', async () => {
    const p = await pickFolder('Allow MechApe to read this folder');
    if (!p) return null;
    const cur = loadSettings().fsRoots;
    const base = Array.isArray(cur) && cur.length ? cur : [os.homedir()]; // default & whole-disk start from home
    return applyStorageChange({ fsRoots: [...new Set([...base, p])] });
  });
  handleUI('prefs:fs-remove-root', (p) => {
    const roots = fsRootsList().filter(r => r !== p);
    return applyStorageChange({ fsRoots: roots.length ? roots : undefined }); // empty → back to default home
  });
  handleUI('prefs:fs-whole-disk', () => applyStorageChange({ fsRoots: 'all' }));
  handleUI('prefs:fs-reset-home', () => applyStorageChange({ fsRoots: undefined }));

  /* CUDA opt-in. Clears the remembered build so the next launch re-walks the
   * chain and installs (or stops using) CUDA — without that, the remembered
   * variant would win the fast path and the toggle would appear to do
   * nothing. No server restart: the backend build is chosen at app boot, so
   * this genuinely needs a relaunch, which the UI says plainly. */
  handleUI('prefs:set-use-cuda', (on) => {
    /* Clear the remembered build and any rejection record: toggling this is
     * a request to re-decide from scratch on the next launch. Without that,
     * the remembered variant wins the fast path and the switch looks broken.
     * `preferCuda` is the retired opt-in flag from when CUDA wasn't the
     * NVIDIA default — dropped here so an old settings file can't keep
     * forcing CUDA onto a machine that has since opted out. */
    saveSettings({
      cudaOptOut: on ? undefined : true,
      preferCuda: undefined,
      llamacppVariant: undefined,
      llamacppRejected: undefined,
    });
    return prefsSummary();
  });

  handleUI('prefs:open-data-folder', () => { shell.openPath(effectiveStorage().dataDir); });

  // OpenRouter key: save (encrypted) or clear, then restart the server so it
  // picks the key up from its env. The renderer sends the key one way and
  // only ever reads back a boolean.
  handleUI('prefs:set-openrouter-key', async (key) => {
    setOpenRouterKey(key);
    await restartServer();
    return prefsSummary();
  });

  // remote privacy routing (deny logging providers vs. allow all)
  handleUI('prefs:set-or-logging', (allow) => applyStorageChange({ orAllowLogging: Boolean(allow) || undefined }));

  handleUI('llamacpp:embed-prompt', (info) => promptEmbedModel(info));
  handleUI('llamacpp:chat-prompt', (info) => promptChatModel(info));
}

module.exports = { registerPrefsIpc };
