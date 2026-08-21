/**
 * mcp.js — Model Context Protocol host.
 *
 * Skills tell a model *how* to behave. MCP gives it things it can actually
 * do: read a calendar, query a database, search a wiki. This module speaks
 * the client half of the protocol over stdio, so any of the existing MCP
 * servers can be plugged in unmodified.
 *
 * The config file is deliberately Claude Desktop's format, so a server
 * someone already configured there can be pasted across without edits:
 *
 *   {
 *     "mcpServers": {
 *       "filesystem": {
 *         "command": "npx",
 *         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
 *         "env": { "SOME_TOKEN": "..." },
 *         "disabled": false          // MechApe extension: keep but skip
 *       }
 *     }
 *   }
 *
 * ---- the honest part ----
 *
 * MechApe's promise is that nothing leaves your machine. An MCP server is a
 * program you choose to run, and it can do whatever that program does —
 * including talk to the network. Connecting one is stepping outside the
 * guarantee, knowingly. So:
 *
 *   - there is no default server and no bundled catalog that auto-installs;
 *     the file starts empty and nothing runs until you write it
 *   - servers only start when a chat actually has tools enabled
 *   - every tool call is logged, and the UI names the server that ran it
 *   - a server that misbehaves is contained: bounded startup, bounded call
 *     timeouts, bounded output, and a crash takes down that server only
 *
 * Transport note: MCP's stdio transport is newline-delimited JSON-RPC 2.0.
 * Messages may not contain embedded newlines, which is what makes a plain
 * line reader sufficient here — no Content-Length framing.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { MCP_CONFIG, MCP_CALL_TIMEOUT, MCP_STARTUP_TIMEOUT } = require('./config');
const { logError, logInfo } = require('./log');

const PROTOCOL_VERSION = '2024-11-05';

/* A tool name reaching the model is "<server>__<tool>", so two servers that
 * both expose "search" stay distinct and the result can be routed back to
 * whichever one owns it. Double underscore because MCP tool names are
 * commonly snake_case and a single one would be ambiguous. */
const NS = '__';

/* Cap what a tool can return. A server that dumps a database into the reply
 * would otherwise blow the context window and cost a fortune in tokens. */
const MAX_RESULT_CHARS = 24 * 1024;

const servers = new Map(); // name -> { proc, tools, nextId, pending, ready }

/* ---- config ---- */

/**
 * Read and validate mcp.json. Returns {} when absent — the overwhelmingly
 * common case, and not an error: no config means no integrations, which is
 * the default posture.
 */
function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(MCP_CONFIG, 'utf8');
  } catch {
    return {};
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    logError('mcp config', new Error(`${MCP_CONFIG} is not valid JSON: ${e.message}`));
    return {};
  }
  const out = {};
  const entries = (parsed && parsed.mcpServers) || {};
  for (const [name, cfg] of Object.entries(entries)) {
    if (!cfg || typeof cfg !== 'object') continue;
    if (cfg.disabled === true) continue;
    if (typeof cfg.command !== 'string' || !cfg.command.trim()) {
      logError('mcp config', new Error(`server "${name}" has no command — skipped`));
      continue;
    }
    // A name that isn't a plain identifier would break the "<server>__<tool>"
    // round-trip, and would let a config file smuggle odd characters into a
    // tool name the model sees.
    if (!/^[A-Za-z0-9_-]+$/.test(name)) {
      logError('mcp config', new Error(`server name "${name}" must be letters, digits, - or _ — skipped`));
      continue;
    }
    out[name] = {
      command: cfg.command,
      args: Array.isArray(cfg.args) ? cfg.args.map(String) : [],
      env: (cfg.env && typeof cfg.env === 'object') ? cfg.env : {},
    };
  }
  return out;
}

/** Does the user have any integration configured at all? */
function isConfigured() {
  return Object.keys(loadConfig()).length > 0;
}

/* ---- launching a server process ----
 *
 * `spawn('npx', args)` does not work on Windows at all, and the way it fails
 * is worth writing down, because the config format this module deliberately
 * copies is full of `"command": "npx"`:
 *
 *   spawn('npx')       ENOENT — libuv does not consult PATHEXT, so the bare
 *                      name never resolves to npx.cmd
 *   spawn('npx.cmd')   EINVAL — since Node 18.20/20.12. A batch file is
 *                      interpreted by cmd.exe, and passing arguments to one
 *                      without a shell was CVE-2024-27980; Node now refuses
 *                      outright rather than quote it wrongly
 *   { shell: true }    works, and concatenates the arguments into a command
 *                      line unescaped — Node's own DEP0190 warns about
 *                      exactly this. mcp.json is a file the user may have
 *                      pasted in from somewhere; its arguments have no
 *                      business reaching cmd.exe as syntax
 *
 * So resolve the command the way a shell would, and when that lands on a
 * batch file, invoke it through COMSPEC with the quoting done here.
 */
const IS_WINDOWS = process.platform === 'win32';

/** Absolute path to `command`, searched along PATH (and PATHEXT on Windows). */
function resolveCommand(command) {
  if (command.includes('/') || command.includes('\\')) return path.resolve(command);
  const exts = IS_WINDOWS
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').map(e => e.trim()).filter(Boolean)
    : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const full = path.join(dir, command + ext);
      // X_OK is meaningless on Windows — it passes for every readable file.
      // There, the extension having come from PATHEXT *is* the platform's
      // own answer to "would a shell run this".
      try {
        fs.accessSync(full, IS_WINDOWS ? fs.constants.F_OK : fs.constants.X_OK);
        return full;
      } catch { /* keep looking */ }
    }
  }
  return null;
}

/* Quote one argument for a command line cmd.exe will parse. Two parsers see
 * it in turn: cmd itself, then the batch file's own MSVCRT-style splitter.
 * Wrapping in double quotes satisfies the second and stops the first reading
 * spaces or & | < > as syntax; an embedded quote additionally needs the run
 * of backslashes in front of it doubled, which is the rule that splitter
 * actually implements.
 *
 * Not handled, and said plainly rather than left to be discovered: a literal
 * % naming a variable is still expanded by cmd. There is no escape for it on
 * a command line (%% is batch-file syntax, not this), and every other
 * launcher on Windows has the same hole. Since childEnv below hands the
 * child a small environment of our choosing, the worst case is an argument
 * losing a fragment rather than gaining a secret. */
function quoteForCmd(arg) {
  const s = String(arg)
    .replace(/(\\*)"/g, '$1$1\\"')  // backslash run before a quote doubles; the quote escapes
    .replace(/(\\+)$/, '$1$1');      // and a trailing run doubles too, since a quote follows it
  return `"${s}"`;
}

/* ---- what the child is allowed to see ----
 *
 * This used to be `{ ...process.env, ...cfg.env }`, justified by `npx` and
 * `uvx` needing PATH to resolve. They do — but the same line also handed
 * every MCP server the user's billable MECHAPE_OPENROUTER_KEY, the location
 * of their projects, and the exact list of folders this app may read. An MCP
 * server is a program the user chose to run; choosing to run a calendar
 * server is not choosing to give it your API key, and a server that never
 * gets called as a tool could still spend your credits.
 *
 * An allowlist rather than a denylist, because a denylist has to be updated
 * every time the app learns a new secret, and one day it won't be. This one
 * fails closed, and fails loudly: a server missing something it needs won't
 * start, gets logged, and shows up in the failures list.
 *
 * Every name below earns its place — PATH and PATHEXT to find the command,
 * SystemRoot/COMSPEC because winsock and anything that shells out break
 * without them, the APPDATA/XDG pair because that is where npm and uv keep
 * their caches, TEMP because npx unpacks there, and the proxy and CA-bundle
 * variables because without them `npx -y <pkg>` hangs behind a corporate
 * proxy instead of failing in a way anyone can diagnose.
 *
 * Deliberately absent, beyond every MECHAPE_ and MONKII_ name: NODE_OPTIONS
 * (ambient --require injection into the child) and PORT (electron/server.js
 * sets it to *our* port, and a server that reads it would bind somewhere
 * surprising). */
const ENV_ALLOW = [
  'PATH', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'windir', 'SystemDrive',
  'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'APPDATA', 'LOCALAPPDATA', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS',
  'HOME', 'USER', 'LOGNAME', 'SHELL',
  'TEMP', 'TMP', 'TMPDIR',
  'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
];

/**
 * The environment one MCP server is launched with: the allowlist above, the
 * server's own `env` block on top, and nothing else.
 *
 * MECHAPE_MCP_INHERIT="GITHUB_TOKEN,FOO" is the escape hatch, because some
 * server genuinely does read a token from the ambient environment and the
 * alternative would be telling people to paste that secret into a config
 * file. Opt-in, per name, and visible in one place.
 */
function childEnv(serverEnv) {
  const extra = String(process.env.MECHAPE_MCP_INHERIT || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const out = {};
  const seen = new Set();
  for (const name of [...ENV_ALLOW, ...extra]) {
    // Windows resolves environment names case-insensitively, so HTTP_PROXY
    // and http_proxy are one variable there — take the first spelling that
    // hits rather than handing the child the same value under two keys.
    const key = IS_WINDOWS ? name.toLowerCase() : name;
    if (seen.has(key)) continue;
    const v = process.env[name];
    if (v === undefined) continue;
    seen.add(key);
    out[name] = v;
  }
  return { ...out, ...serverEnv };   // a server's own vars still win
}

/** Spawn one configured server, working around Windows batch-file launching. */
function spawnServer(cfg) {
  const opts = {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: childEnv(cfg.env),
  };
  const exe = resolveCommand(cfg.command);
  if (!exe) {
    throw new Error(`"${cfg.command}" is not on PATH — install it, or put the full path in mcp.json`);
  }
  if (IS_WINDOWS && /\.(cmd|bat)$/i.test(exe)) {
    const line = [exe, ...cfg.args].map(quoteForCmd).join(' ');
    // /d skips any AutoRun script, /s plus the outer quote pair tells cmd to
    // strip exactly that pair and leave our quoting untouched, /c runs and
    // exits. windowsVerbatimArguments because Node would otherwise re-quote
    // the whole line into a single argument and cmd would see one blob.
    return spawn(process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`],
      { ...opts, windowsVerbatimArguments: true });
  }
  return spawn(exe, cfg.args, opts);
}

/* ---- one server ---- */

function startServer(name, cfg) {
  const proc = spawnServer(cfg);

  const s = { proc, name, tools: [], nextId: 1, pending: new Map(), buf: '' };

  proc.stdout.on('data', (chunk) => {
    s.buf += chunk.toString('utf8');
    let nl;
    while ((nl = s.buf.indexOf('\n')) >= 0) {
      const line = s.buf.slice(0, nl).trim();
      s.buf = s.buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // servers do log to stdout sometimes
      const p = msg.id != null && s.pending.get(msg.id);
      if (!p) continue;                                    // notification, or a reply we no longer want
      s.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'MCP error'));
      else p.resolve(msg.result);
    }
  });

  // Servers use stderr for diagnostics; keep it out of the user's face but
  // don't discard it — a server that won't start is otherwise a silent void.
  proc.stderr.on('data', (d) => {
    const t = d.toString('utf8').trim();
    if (t) logInfo(`mcp:${name}`, t.slice(0, 500));
  });

  proc.on('exit', (code) => {
    for (const [, p] of s.pending) { clearTimeout(p.timer); p.reject(new Error(`${name} exited`)); }
    s.pending.clear();
    servers.delete(name);
    if (code !== 0) logError(`mcp:${name}`, new Error(`server exited with code ${code}`));
  });

  proc.on('error', (e) => {
    servers.delete(name);
    logError(`mcp:${name}`, e);
  });

  return s;
}

function request(s, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = s.nextId++;
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error(`${s.name}: ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    s.pending.set(id, { resolve, reject, timer });
    try {
      s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    } catch (e) {
      s.pending.delete(id);
      clearTimeout(timer);
      reject(e);
    }
  });
}

function notify(s, method, params) {
  try { s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`); } catch { /* dead */ }
}

/** Spawn, handshake, and cache the tool list for one server. */
async function connect(name, cfg) {
  const s = startServer(name, cfg);
  await request(s, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'MechApe', version: require('../package.json').version },
  }, MCP_STARTUP_TIMEOUT);
  notify(s, 'notifications/initialized', {});
  const res = await request(s, 'tools/list', {}, MCP_STARTUP_TIMEOUT);
  s.tools = Array.isArray(res && res.tools) ? res.tools : [];
  servers.set(name, s);
  logInfo('mcp', `${name}: ${s.tools.length} tool(s)`);
  return s;
}

/* ---- public surface ---- */

/**
 * Start every configured server and return their tools in the OpenAI
 * function-calling shape llama-server expects.
 *
 * One server failing to start does not sink the rest: it is logged, reported
 * back for the UI, and the others carry on. A broken integration should
 * degrade the tool list, not the chat.
 */
async function startAll() {
  const cfg = loadConfig();
  const failures = [];
  await Promise.all(Object.entries(cfg).map(async ([name, c]) => {
    if (servers.has(name)) return;
    try { await connect(name, c); } catch (e) {
      failures.push({ server: name, error: e.message });
      logError(`mcp:${name}`, e);
    }
  }));
  return { tools: toolDefs(), failures };
}

function stopAll() {
  for (const [, s] of servers) { try { s.proc.kill(); } catch { /* already gone */ } }
  servers.clear();
}

/** Tools across all connected servers, as OpenAI function definitions. */
function toolDefs() {
  const defs = [];
  for (const [name, s] of servers) {
    for (const t of s.tools) {
      if (!t || typeof t.name !== 'string') continue;
      defs.push({
        type: 'function',
        function: {
          name: `${name}${NS}${t.name}`,
          description: t.description || '',
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      });
    }
  }
  return defs;
}

/** What the UI lists under Integrations. */
function status() {
  const configured = Object.keys(loadConfig());
  return configured.map(name => {
    const s = servers.get(name);
    return { name, connected: !!s, tools: s ? s.tools.map(t => t.name) : [] };
  });
}

/**
 * Run one tool call. Never throws: a failing tool has to come back as text
 * the model can read and react to, because the alternative is aborting a
 * chat because someone's calendar server is down.
 */
async function callTool(qualifiedName, args) {
  const at = qualifiedName.indexOf(NS);
  if (at < 0) return `Error: unknown tool "${qualifiedName}".`;
  const serverName = qualifiedName.slice(0, at);
  const toolName = qualifiedName.slice(at + NS.length);
  const s = servers.get(serverName);
  if (!s) return `Error: integration "${serverName}" is not connected.`;

  try {
    const res = await request(s, 'tools/call', { name: toolName, arguments: args || {} }, MCP_CALL_TIMEOUT);
    return truncate(flatten(res));
  } catch (e) {
    logError(`mcp:${serverName}/${toolName}`, e);
    return `Error calling ${qualifiedName}: ${e.message}`;
  }
}

/* MCP results are a content array of typed parts. The model only wants text,
 * so pull the text out and describe anything else rather than dropping it
 * silently — "there was an image here" is more useful than nothing. */
function flatten(res) {
  const parts = (res && Array.isArray(res.content)) ? res.content : [];
  const out = parts.map(p => {
    if (!p || typeof p !== 'object') return '';
    if (p.type === 'text') return String(p.text || '');
    if (p.type === 'resource' && p.resource) return String(p.resource.text || `[resource: ${p.resource.uri || 'unknown'}]`);
    return `[${p.type || 'unknown'} content omitted]`;
  }).filter(Boolean).join('\n');
  if (res && res.isError) return `Tool reported an error: ${out || 'no detail'}`;
  return out || '(the tool returned nothing)';
}

function truncate(text) {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n…[truncated: the tool returned ${text.length} characters]`;
}

module.exports = {
  childEnv,           // exported for tests
  loadConfig, isConfigured, startAll, stopAll, toolDefs, status, callTool,
  // exported for tests
  flatten, truncate, NS, MAX_RESULT_CHARS,
};
