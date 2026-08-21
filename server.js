/**
 * server.js — application entry point.
 *
 * Wires everything together and nothing more: applies the security
 * middleware, mounts the API routers, serves the static frontend, installs
 * the leak-free error handler, and starts listening on loopback. All real
 * logic lives in lib/ (domain modules) and routes/ (HTTP endpoints):
 *
 *   lib/config.js       env + constants          routes/projects.js  projects/chats/attachments CRUD
 *   lib/security.js     host/origin/CSP + fs allowlist   routes/skills.js    skill listing
 *   lib/store.js        project JSON persistence  routes/fs.js        file-browser listings
 *   lib/skills.js       SKILL.md parsing          routes/models.js    health/models/chat stream
 *   lib/attachments.js  reading knowledge from disk   routes/search.js    search across projects/chats/messages
 *   lib/prompt.js       system prompt assembly
 *   lib/llamacpp.js     llama.cpp server HTTP client
 */
const path = require('path');
const express = require('express');

const { PORT, LLAMACPP_CHAT_URL, LLAMACPP_EMBED_URL, SKILLS_DIR, ROOT } = require('./lib/config');
const { securityMiddleware } = require('./lib/security');
const { logError, logInfo, LOG_DIR } = require('./lib/log');

// last-resort logging so nothing dies silently
process.on('uncaughtException', (e) => logError('uncaughtException', e));
process.on('unhandledRejection', (e) => logError('unhandledRejection', e));

/* Assembling the app is separate from listening on a port so tests can drive
 * the real stack — the same middleware, routers and error handler, in the
 * order they actually run — rather than a hand-built imitation of it. That
 * order is the part worth testing: the security middleware has to sit ahead
 * of the body parser, the static tree, and every router. */
function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityMiddleware);
  app.use(express.json({ limit: '4mb' }));
  app.use(express.static(path.join(ROOT, 'public')));

  app.use('/api', require('./routes/projects'));
  app.use('/api', require('./routes/skills'));
  app.use('/api', require('./routes/fs'));
  app.use('/api', require('./routes/search'));
  app.use('/api', require('./routes/models'));
  app.use('/api', require('./routes/backup'));

  /* JSON error handler — no stack traces to the client, but log the real one */
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    const status = err.type === 'entity.parse.failed' ? 400
      : err.type === 'entity.too.large' ? 413
      : err.status || 500;
    if (status >= 500) logError(`${req.method} ${req.path}`, err);
    res.status(status).json({ error: status < 500 ? 'invalid request body' : 'internal error' });
  });

  return app;
}

module.exports = { createApp };

/* Listen only when run as a program. The desktop shell forks this file
 * (electron/server.js), which still satisfies require.main === module, so
 * that path is unchanged; a test that requires it gets the app and no
 * socket. */
if (require.main === module) {
  createApp().listen(PORT, '127.0.0.1', () => {
    console.log(`MechApe running at http://localhost:${PORT}`);
    console.log(`llama.cpp chat:  ${LLAMACPP_CHAT_URL}`);
    console.log(`llama.cpp embed: ${LLAMACPP_EMBED_URL}`);
    console.log(`Skills dir:  ${SKILLS_DIR}`);
    console.log(`Logs dir:    ${LOG_DIR}`);
    logInfo('server started', `port ${PORT}`);
  });
}
