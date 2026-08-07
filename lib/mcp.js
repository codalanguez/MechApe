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

/* ---- one server ---- */

function startServer(name, cfg) {
  const proc = spawn(cfg.command, cfg.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // Inherit the ambient environment so `npx`, `uvx` etc. resolve, with the
    // server's own vars layered on top.
    env: { ...process.env, ...cfg.env },
  });

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
  loadConfig, isConfigured, startAll, stopAll, toolDefs, status, callTool,
  // exported for tests
  flatten, truncate, NS, MAX_RESULT_CHARS,
};
