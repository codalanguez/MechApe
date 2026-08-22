/**
 * main.js — desktop shell entry point: window + app lifecycle.
 *
 * Turns the loopback web app into a native desktop application (the way the
 * ComfyUI desktop app wraps its local Python server). On launch it:
 *
 *   1. downloads + SHA256-verifies the llama-server binary if needed, and
 *      picks free ports for the chat and embed instances,
 *   2. forks server.js on a free port using Electron's bundled Node (which,
 *      once running, spawns those llama-server instances itself on demand —
 *      see lib/llamacpp.js),
 *   3. waits for the HTTP server to answer, then
 *   4. loads it in a BrowserWindow, showing a themed splash while it boots.
 *
 * The Express server is used completely unmodified — `npm start` still runs
 * it headless (pointed at manually-started llama-server instances). Everything
 * desktop-specific lives in this folder, one module per concern:
 *
 *   runtime.js    shared state (window, server process, port)
 *   settings.js   settings.json + storage-location resolution
 *   dialogs.js    native-dialog helpers
 *   llamacpp.js   downloading + verifying the llama-server binary
 *   server.js     fork/wait/restart of the Express server + llama PID tracking
 *   menu.js       app menu with live Projects & Skills submenus
 *   prefs-ipc.js  Preferences IPC (validated senders)
 *   preload.js    contextBridge exposed to the web UI
 */
const { app, BrowserWindow, Menu, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const runtime = require('./runtime');
const { ensureLlamaCppBinary } = require('./llamacpp');
const { findFreePort, waitForServer, startServer, killTrackedLlamaProcesses, sendToServer } = require('./server');
const { auditOpenRouterKey } = require('./settings');
const { buildMenu } = require('./menu');
const { registerPrefsIpc } = require('./prefs-ipc');

/* Every name this app has shipped under, newest first. Each rename moves
 * per-user storage (productName decides the %APPDATA% folder), so a launch
 * under the current name has to go looking for whatever the last one left
 * behind. These are deliberately hard-coded historical strings — they must
 * NOT be renamed along with the product, or an upgrade silently starts with
 * an empty library. */
const LEGACY_APP_NAMES = ['Monkii', 'CodeMonkii'];

/**
 * One-time data migration across the app's renames (CodeMonkii → Monkii →
 * MechApe). On first launch under a new name, copy the previous install's
 * projects, skills, settings, logs, and downloaded runtime across so nothing
 * is orphaned.
 *
 * The one thing that cannot survive the copy is the OpenRouter key. Being on
 * the same machine as the same user is not enough: safeStorage encrypts with
 * an AES key kept in the *old* app's "Local State" file, which stays behind,
 * so the copied ciphertext is undecryptable here. auditOpenRouterKey (see
 * settings.js) notices that on the next boot, clears the dead blob, and
 * leaves Preferences a note to ask for the key again — rather than the app
 * quietly presenting itself as fully local.
 *
 * Takes the newest legacy folder that actually exists, copies file-by-file,
 * never overwrites anything the new install already has, and only writes the
 * `.migrated` marker if every file copied cleanly — so a partial run (a
 * momentarily locked file, an antivirus holding a binary) is retried next
 * launch rather than silently leaving data behind. Runs before storage paths
 * are read.
 */
function migrateLegacyData() {
  if (!app.isPackaged) return; // dev keeps its data repo-local
  try {
    const newDir = app.getPath('userData'); // %APPDATA%\MechApe
    const marker = path.join(newDir, '.migrated');
    if (fs.existsSync(marker)) return;

    const oldDir = LEGACY_APP_NAMES
      .map(name => path.join(app.getPath('appData'), name))
      .find(dir => fs.existsSync(dir));
    if (!oldDir) return;

    let failures = 0;
    const copyInto = (src, dst) => {
      if (!fs.existsSync(src)) return;
      if (fs.statSync(src).isDirectory()) {
        fs.mkdirSync(dst, { recursive: true });
        for (const name of fs.readdirSync(src)) copyInto(path.join(src, name), path.join(dst, name));
      } else if (!fs.existsSync(dst)) {
        try { fs.copyFileSync(src, dst); } catch { failures++; }
      }
    };
    // `runtime` carries the verified llama.cpp builds — worth bringing over so
    // an opted-in CUDA install isn't re-downloaded after a rename
    for (const item of ['data', 'skills', 'settings.json', 'logs', 'runtime']) {
      copyInto(path.join(oldDir, item), path.join(newDir, item));
    }
    if (failures === 0) fs.writeFileSync(marker, new Date().toISOString());
    console.log(`[mechape] migrated data from ${path.basename(oldDir)} -> ${path.basename(newDir)}`);
  } catch { /* best-effort: a failed migration just retries; no data lost */ }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0b14',
    show: false,
    title: 'MechApe',
    icon: runtime.IS_WINDOWS ? path.join(__dirname, 'build', 'icon.ico') : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  runtime.win = win;

  // Splash while the server boots.
  win.loadFile(path.join(__dirname, 'loading.html'));
  win.once('ready-to-show', () => win.show());

  // Open external links (docs, huggingface.co, etc.) in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (!runtime.isAppUrl(url)) {
      if (/^https?:/i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // The window itself may only ever show the app (or its splash) — anything
  // that would navigate it elsewhere opens in the real browser instead. This
  // also keeps the preload IPC bridge out of reach of any foreign page.
  win.webContents.on('will-navigate', (e, url) => {
    if (!runtime.isAppUrl(url)) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });

  // A loopback chat UI has no business using camera/mic/location/etc.
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(false));

  // Native cut/copy/paste menu for text fields — Electron ships none by
  // default. Non-editable targets are handled by the web UI's own menus.
  win.webContents.on('context-menu', (e, params) => {
    if (!params.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'undo' }, { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
      { type: 'separator' },
      { role: 'selectAll' },
    ]).popup({ window: win });
  });

  // Keep the menu's Projects/Skills submenus in sync with app data.
  win.on('focus', () => { buildMenu(); });

  win.on('closed', () => { runtime.win = null; });
}

const fmtMB = (n) => `${Math.round(n / 1048576)} MB`;

/**
 * Narrate first-run backend setup on the splash screen.
 *
 * Without this the very first launch sits on a static splash for minutes
 * while a 250 MB build downloads and unpacks, with nothing to distinguish
 * "working" from "hung" — which is exactly how it read the first time it was
 * run for real. Writes into the splash's own `.sub` line; harmless no-op
 * once the real UI has loaded over it.
 */
function setupText(p) {
  if (p.status === 'downloading' && p.total) return `Downloading local model runtime — ${Math.round((p.completed / p.total) * 100)}% of ${fmtMB(p.total)}`;
  if (p.status === 'downloading') return 'Downloading local model runtime…';
  if (p.status === 'unpacking') return 'Unpacking local model runtime — this takes a minute';
  return p.status.charAt(0).toUpperCase() + p.status.slice(1) + '…';
}

function reportSetupProgress(p) {
  const text = setupText(p);
  /* The app is already on screen by the time most of this arrives, so the
   * status pill is where it belongs — the splash line is only still the right
   * home for the brief moment before the server answers. */
  sendToServer({ type: 'llamacpp:setup', state: { text, status: p.status } });

  const win = runtime.win;
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(
    `(() => { const el = document.querySelector('.sub'); if (el) el.textContent = ${JSON.stringify(text)}; })()`,
  ).catch(() => { /* splash already replaced by the app */ });
}

async function boot() {
  migrateLegacyData(); // carry data over from an install under a previous name
  auditOpenRouterKey(); // ...but not the API key, which a rename leaves undecryptable
  buildMenu();
  createWindow();

  /* Ports first — three cheap loopback picks — then start the server and show
   * the app. The llama.cpp build is resolved afterwards, in the background.
   *
   * It used to be the other way around, and the cost was the whole product:
   * ensureLlamaCppBinary was awaited before the server was even forked, so
   * every launch sat on a splash until the backend question was settled. On a
   * first run that is a 250 MB CUDA download. On a machine whose antivirus has
   * quarantined llama-server.exe it is a full re-extract, every single time.
   * Measured on the author's machine: 102 seconds to reach a UI that needed
   * none of it — projects, chats, skills, settings and remote models are all
   * served without a local backend, and the one thing that does need it says
   * so on its own. */
  const [serverPort, chatPort, embedPort] = await Promise.all([
    findFreePort(runtime.PREFERRED_PORT),
    findFreePort(8114),
    findFreePort(8115),
  ]);
  runtime.serverPort = serverPort;

  /* The instance URLs are known now and never change; only the binary arrives
   * late. Kept in llamacppEnv as well as sent over IPC, because a Preferences
   * change re-forks the server and the fresh process learns everything from
   * its environment. */
  runtime.llamacppEnv = {
    MECHAPE_LLAMACPP_CHAT_URL: `http://127.0.0.1:${chatPort}`,
    MECHAPE_LLAMACPP_EMBED_URL: `http://127.0.0.1:${embedPort}`,
  };
  startServer(runtime.serverPort, runtime.llamacppEnv);

  try {
    await waitForServer(runtime.serverPort);
    if (runtime.win) await runtime.win.loadURL(runtime.appUrl());
    buildMenu(); // now with live projects & skills
  } catch (e) {
    dialog.showErrorBox('MechApe', `Could not reach the app server.\n\n${e.message}`);
    return app.quit();
  }

  /* Claim the state before doing the work. Between the server answering and
   * the first progress event there is a gap of a second or two, and without
   * this the health endpoint reports the raw failure of a probe against a
   * backend that was never started — the pill would read "local models
   * unavailable — fetch failed" for a moment during a perfectly normal
   * startup, which is both alarming and untrue. */
  sendToServer({ type: 'llamacpp:setup', state: { text: 'Preparing the local model runtime…', status: 'starting' } });

  resolveBackend();   // deliberately not awaited
}

/**
 * Find (downloading and SHA256-verifying on a first run) the llama.cpp build,
 * and hand it to the already-running server.
 *
 * Failure is reported through the status pill rather than a modal dialog: the
 * app is on screen and working by now, and a modal over a usable window to say
 * "local chat is unavailable" interrupts someone who may be perfectly happy
 * using a remote model.
 */
async function resolveBackend() {
  try {
    const backend = await ensureLlamaCppBinary(reportSetupProgress);
    runtime.llamacppEnv = {
      ...runtime.llamacppEnv,
      MECHAPE_LLAMACPP_BIN: backend.bin,
      MECHAPE_LLAMACPP_VARIANT: backend.variant,
      // e.g. "Vulkan1" — without this llama.cpp offloads to device 0, which
      // on a laptop is usually the integrated GPU, not the discrete card
      MECHAPE_LLAMACPP_DEVICE: backend.device ? backend.device.id : '',
    };
    sendToServer({
      type: 'llamacpp:config',
      bin: backend.bin,
      variant: backend.variant,
      device: backend.device ? backend.device.id : '',
    });
  } catch (e) {
    console.warn(`[mechape] local model backend unavailable: ${e.message}`);
    sendToServer({
      type: 'llamacpp:setup',
      state: { failed: true, text: `Local models unavailable — ${e.message}` },
    });
  }
}

// Single-instance: focus the existing window instead of launching a second copy.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  registerPrefsIpc();

  app.on('second-instance', () => {
    const { win } = runtime;
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(boot);

  app.on('activate', () => {
    // reopen just the window — the server (if still up) keeps running
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
      if (runtime.serverProc) runtime.win.loadURL(runtime.appUrl());
      else boot();
    }
  });

  app.on('window-all-closed', () => app.quit());

  app.on('before-quit', () => { app.isQuitting = true; });

  app.on('quit', () => {
    // Unlike the old Ollama integration (left running deliberately — it was
    // a shared system daemon other tools might use), the llama-server
    // instances are MechApe's own private processes: kill them explicitly so
    // nothing lingers after the app closes. Order matters: the tracked-PID
    // kill must run before (or without depending on) the forked server,
    // since killing that server on Windows won't let it clean up its own
    // children — see the comment in electron/server.js.
    killTrackedLlamaProcesses();
    try { runtime.serverProc?.kill(); } catch {}
  });
}
