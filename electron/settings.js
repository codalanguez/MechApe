/**
 * settings.js — persisted preferences and storage-location resolution.
 *
 * Settings live in a small JSON file in Electron's per-user data dir
 * (e.g. %APPDATA%\MechApe\settings.json). Keys:
 *   modelsDir — where downloaded .gguf files live (absent = default)
 *   dataDir   — where projects & chats are stored  (absent = default)
 *   skillsDir — where skills are scanned from       (absent = default)
 *   llamacppVariant — 'cuda' | 'cpu' | 'auto', remembered after the first
 *     successful (or failed) launch so MechApe doesn't re-probe every boot
 *     (see electron/llamacpp.js)
 *
 * Storage locations resolve in priority order:
 *   1. MECHAPE_DATA_DIR / MECHAPE_SKILLS_DIR / MECHAPE_MODELS_DIR env vars — always win;
 *   2. folders picked in the in-app Preferences panel (saved here);
 *   3. defaults — %APPDATA%\MechApe when installed (the install folder is
 *      replaced wholesale on every update, so user data can't live there),
 *      repo-local in dev, same as `npm start`.
 */
const { app, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const runtime = require('./runtime');

/* Same MECHAPE_* -> MONKII_* fallback lib/config.js applies, so the shell and
 * the server agree about which env overrides are in force. Without it a
 * pre-rename MONKII_DATA_DIR would still steer the server while Preferences
 * showed the folder as user-editable — two answers to the same question. */
function env(name) {
  const v = process.env[`MECHAPE_${name}`];
  return v !== undefined ? v : process.env[`MONKII_${name}`];
}

const settingsPath = () => path.join(app.getPath('userData'), 'settings.json');

function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); }
  catch { return {}; }
}

/** Shallow-merge `patch` into the saved settings (undefined deletes a key). */
function saveSettings(patch) {
  const next = { ...loadSettings(), ...patch };
  try { fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2)); } catch {}
  return next;
}

function defaultStorage() {
  const base = app.isPackaged ? app.getPath('userData') : runtime.APP_ROOT;
  return {
    dataDir: path.join(base, 'data', 'projects'),
    skillsDir: path.join(base, 'skills'),
    modelsDir: path.join(base, 'data', 'models'),
  };
}

function effectiveStorage() {
  const s = loadSettings();
  const d = defaultStorage();
  return {
    dataDir: env('DATA_DIR') || s.dataDir || d.dataDir,
    skillsDir: env('SKILLS_DIR') || s.skillsDir || d.skillsDir,
    modelsDir: env('MODELS_DIR') || s.modelsDir || d.modelsDir,
  };
}

/** Logs live beside the per-user data when installed, repo-local in dev. */
function logDir() {
  const base = app.isPackaged ? app.getPath('userData') : runtime.APP_ROOT;
  return env('LOG_DIR') || path.join(base, 'logs');
}

/* Filesystem allowlist (MECHAPE_FS_ROOTS). The desktop app fences browsing and
 * attachment reads to your home folder by default; widen it in Preferences.
 * The `fsRoots` setting is either an array of allowed folders, the string 'all'
 * (whole disk), or absent (default = home). The ambient env var always wins. */
function fsRootsSetting() { return loadSettings().fsRoots; }

/** Effective allowed folders. An empty array means the whole disk (no fence). */
function fsRootsList() {
  // NB: don't name this `env` — a local `const env` shadows the env() helper
  // above for the whole function body, so the call initialising it lands in
  // its own temporal dead zone and throws "Cannot access 'env' before
  // initialization". That shipped once: it killed the forked server on every
  // launch of the packaged app, which then hung on the splash screen forever.
  const raw = env('FS_ROOTS');
  if (raw !== undefined) return raw.split(';').map(s => s.trim()).filter(Boolean);
  const s = fsRootsSetting();
  if (s === 'all') return [];
  if (Array.isArray(s) && s.length) return s;
  return [os.homedir()];
}
const fsWholeDisk = () => fsRootsList().length === 0;

/** The MECHAPE_FS_ROOTS value handed to the forked server (ambient env wins;
 * otherwise the effective list, where [] means whole disk → empty string). */
function fsRootsEnvValue() {
  return (env('FS_ROOTS') !== undefined) ? env('FS_ROOTS') : fsRootsList().join(';');
}

/* ---- OpenRouter API key (optional remote backend) ----
 * Stored OS-encrypted via Electron's safeStorage (DPAPI on Windows) so the
 * settings file never holds it in plaintext. It is only ever handed to the
 * forked local server as an env var — never to the renderer. */
function setOpenRouterKey(key) {
  const k = (key || '').trim();
  if (!k) return saveSettings({ openrouterKey: undefined });
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption unavailable — key not saved');
  return saveSettings({ openrouterKey: safeStorage.encryptString(k).toString('base64') });
}

function openrouterKey() {
  if (env('OPENROUTER_KEY') !== undefined) return env('OPENROUTER_KEY');
  const enc = loadSettings().openrouterKey;
  if (!enc) return '';
  try { return safeStorage.decryptString(Buffer.from(enc, 'base64')); }
  catch { return ''; } // settings copied from another machine/user — undecryptable
}

const openrouterConfigured = () => Boolean(openrouterKey());

/* Remote privacy routing: 'deny' (default) = only providers that don't log or
 * train on prompts; 'allow' widens provider choice. Ambient env wins. */
const orDataCollection = () => (env('OR_DATA_COLLECTION') !== undefined)
  ? (env('OR_DATA_COLLECTION').toLowerCase() === 'allow' ? 'allow' : 'deny')
  : (loadSettings().orAllowLogging ? 'allow' : 'deny');

/** Env block handed to the forked server. Seeds the bundled sample skills
 *  into a fresh skills folder when packaged (never overwriting files). */
function storageEnv() {
  const { dataDir, skillsDir, modelsDir } = effectiveStorage();
  if (app.isPackaged && !fs.existsSync(skillsDir)) {
    try {
      fs.cpSync(path.join(runtime.APP_ROOT, 'skills'), skillsDir, {
        recursive: true, force: false, errorOnExist: false,
      });
    } catch { try { fs.mkdirSync(skillsDir, { recursive: true }); } catch {} }
  }
  return {
    MECHAPE_DATA_DIR: dataDir,
    MECHAPE_SKILLS_DIR: skillsDir,
    MECHAPE_MODELS_DIR: modelsDir,
    MECHAPE_LOG_DIR: logDir(),
    MECHAPE_FS_ROOTS: fsRootsEnvValue(),
    MECHAPE_OPENROUTER_KEY: openrouterKey(),
    MECHAPE_OR_DATA_COLLECTION: orDataCollection(),
  };
}

module.exports = {
  env,
  loadSettings, saveSettings, defaultStorage, effectiveStorage, storageEnv, logDir,
  fsRootsList, fsWholeDisk,
  setOpenRouterKey, openrouterConfigured, orDataCollection,
};
