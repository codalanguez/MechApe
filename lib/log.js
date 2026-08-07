/**
 * log.js — minimal error/event logging to a rotating file.
 *
 * Writes timestamped lines to LOG_DIR/mechape.log so failures (the local
 * llama.cpp backend unreachable, generation errors, uncaught exceptions) leave a trail the
 * user can inspect after the fact — the desktop menu's "Open Logs Folder"
 * points here. One previous file is kept (.old) once the live log passes
 * ~2 MB; everything is best-effort and never throws into the caller.
 */
const fs = require('fs');
const path = require('path');
const { LOG_DIR } = require('./config');

const LOG_FILE = path.join(LOG_DIR, 'mechape.log');
const MAX_BYTES = 2 * 1024 * 1024;

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch { /* logging is best-effort */ }

function rotateIfBig() {
  try {
    if (fs.statSync(LOG_FILE).size > MAX_BYTES) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
  } catch { /* no file yet, or rename raced — ignore */ }
}

function write(level, context, detail) {
  // strip newlines from the caller-supplied context (may contain a model name)
  // so a crafted name can't forge extra lines in the log file
  const safe = String(context).replace(/[\r\n]+/g, ' ');
  const line = `${new Date().toISOString()} [${level}] ${safe}${detail ? ' — ' + detail : ''}\n`;
  try { rotateIfBig(); fs.appendFileSync(LOG_FILE, line); } catch { /* disk full / read-only — ignore */ }
  (level === 'ERROR' ? console.error : console.log)(line.trimEnd());
}

const logError = (context, err) =>
  write('ERROR', context, err && (err.stack || err.message || String(err)));
const logInfo = (context, detail) => write('INFO', context, detail);

module.exports = { logError, logInfo, LOG_FILE, LOG_DIR };
