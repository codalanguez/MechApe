/**
 * server.js — lifecycle of the forked Express server.
 *
 * The web app's own server.js is run completely unmodified in a child
 * process using Electron's bundled Node (ELECTRON_RUN_AS_NODE), on the first
 * free port at/after the preferred one. Storage locations are injected via
 * environment (see settings.storageEnv). Restarting is needed whenever a
 * storage preference changes, because the server reads its config once at
 * boot.
 */
const { app, dialog } = require('electron');
const { fork } = require('child_process');
const path = require('path');
const http = require('http');
const net = require('net');
const runtime = require('./runtime');
const { storageEnv } = require('./settings');

/** Resolve to the first free TCP port at/after `start` on loopback. */
function findFreePort(start) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(findFreePort(start + 1)));
    srv.once('listening', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.listen(start, '127.0.0.1');
  });
}

/** Poll the app URL until it answers (or reject after `timeoutMs`). */
function waitForServer(port, timeoutMs = 30000) {
  const url = `http://127.0.0.1:${port}/`;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() - started > timeoutMs) reject(new Error('server did not start in time'));
        else setTimeout(tick, 300);
      });
    };
    tick();
  });
}

/* PIDs of the llama-server (chat/embed) processes the forked server has
 * spawned (lib/llamacpp.js), reported over the fork's IPC channel. Killing
 * the forked server's ChildProcess handle does NOT reliably kill ITS
 * children on Windows: subprocess.kill() there calls TerminateProcess
 * directly instead of delivering a catchable signal, so the child never
 * gets a chance to clean up its own grandchildren. Tracking PIDs here and
 * killing them directly (same TerminateProcess semantics, but aimed
 * correctly) is what actually guarantees no orphaned llama-server.exe. */
const llamaPids = { chat: null, embed: null };

function killTrackedLlamaProcesses() {
  for (const role of Object.keys(llamaPids)) {
    const pid = llamaPids[role];
    llamaPids[role] = null;
    if (!pid) continue;
    try { process.kill(pid); } catch { /* already gone */ }
  }
}

/** Fork server.js on `port` using Electron's own Node runtime. `extraEnv`
 * (the resolved llama.cpp binary path + instance URLs) is merged in on top
 * of the persisted storage/preference env. */
function startServer(port, extraEnv = {}) {
  const proc = fork(path.join(runtime.APP_ROOT, 'server.js'), [], {
    cwd: runtime.APP_ROOT,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      ...storageEnv(),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  runtime.serverProc = proc;
  proc.stdout?.on('data', (d) => process.stdout.write(`[server] ${d}`));
  proc.stderr?.on('data', (d) => process.stderr.write(`[server] ${d}`));
  proc.on('message', (msg) => {
    if (msg && msg.type === 'llamacpp:pid' && (msg.role === 'chat' || msg.role === 'embed')) {
      llamaPids[msg.role] = msg.pid;
    }
  });
  proc.on('exit', (code) => {
    if (runtime.serverProc === proc) runtime.serverProc = null;
    killTrackedLlamaProcesses(); // the server that owned these just died — nothing left to talk to them
    if (code && !app.isQuitting && !proc.expectedExit) {
      dialog.showErrorBox('MechApe', `The server process exited unexpectedly (code ${code}).`);
      app.quit();
    }
  });
}

/** Kill the forked server (and any llama-server processes it owned), start
 * it again with fresh env, reload the UI. */
async function restartServer(extraEnv) {
  await new Promise((resolve) => {
    const proc = runtime.serverProc;
    if (!proc) return resolve();
    proc.expectedExit = true;
    proc.once('exit', resolve);
    proc.kill();
  });
  startServer(runtime.serverPort, extraEnv || runtime.llamacppEnv || {});
  await waitForServer(runtime.serverPort);
  runtime.win?.webContents.reload();
}

/** Send a message down the fork's IPC channel. Used to hand over the resolved
 *  llama.cpp build, and to narrate progress while it is still being resolved,
 *  without restarting the server (which would reload the UI under the user). */
function sendToServer(msg) {
  try { runtime.serverProc?.send(msg); } catch { /* no channel, or it just died */ }
}

module.exports = {
  findFreePort, waitForServer, startServer, restartServer, killTrackedLlamaProcesses, sendToServer,
};
