/**
 * runtime.js — shared state of the desktop shell.
 *
 * The one place mutable cross-module state lives: the main window, the forked
 * server process, and the port the app is serving on. Modules read current
 * values through this object instead of threading them around as parameters,
 * which keeps the dependency graph acyclic — anything may import runtime;
 * runtime imports nothing.
 */
const path = require('path');
const { pathToFileURL } = require('url');

const runtime = {
  APP_ROOT: path.join(__dirname, '..'),
  IS_WINDOWS: process.platform === 'win32',
  PREFERRED_PORT: Number(process.env.PORT) || 8113,

  win: null,          // main BrowserWindow, null when closed
  serverProc: null,   // forked server.js child process, null when not running
  serverPort: Number(process.env.PORT) || 8113,
  llamacppEnv: null,  // {MECHAPE_LLAMACPP_BIN, MECHAPE_LLAMACPP_CHAT_URL, MECHAPE_LLAMACPP_EMBED_URL} — resolved once at boot, reused by restartServer()

  /** The app's own URL on the current port. */
  appUrl() {
    return `http://127.0.0.1:${runtime.serverPort}/`;
  },

  /** URLs the window itself is allowed to display: the app and its splash.
   * file:// is pinned to the bundled splash page specifically — a blanket
   * file:// pass would let any local HTML file claim the preload bridge. */
  isAppUrl(url) {
    return url.startsWith(`http://127.0.0.1:${runtime.serverPort}/`)
      || url.startsWith(`http://localhost:${runtime.serverPort}/`)
      || url === pathToFileURL(path.join(__dirname, 'loading.html')).href;
  },
};

module.exports = runtime;
