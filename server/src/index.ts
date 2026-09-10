import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { log } from './lib/log.js';
import { sessionManager } from './lib/sessions.js';
import { attachVncBridge } from './lib/vnc-bridge.js';
import { ensureImage, reapOrphans } from './lib/runtime.js';
import { api } from './routes/api.js';

const app = express();
if (config.trustProxy) app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(express.json({ limit: '256kb' }));

app.use((req, res, next) => {
  res.set('access-control-allow-origin', config.corsOrigin);
  res.set('access-control-allow-headers', 'content-type,x-session-token');
  res.set('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

app.use('/api', api);

// Single-container deployments serve the built frontend from the same origin.
if (config.staticDir) {
  const dir = path.resolve(config.staticDir);
  app.use(express.static(dir, { maxAge: '1h', index: 'index.html' }));
  app.get(/^(?!\/api|\/ws).*/, (_req, res) => res.sendFile(path.join(dir, 'index.html')));
}

app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

const server = http.createServer(app);
server.headersTimeout = 65_000;
server.keepAliveTimeout = 61_000;
attachVncBridge(server);

async function main(): Promise<void> {
  await reapOrphans();
  try {
    await ensureImage();
  } catch (err) {
    log.error('browser image unavailable — sessions will fail until it is built', { err: String(err) });
  }
  sessionManager.start();

  server.listen(config.port, config.host, () => {
    log.info('gateway listening', {
      port: config.port,
      capacity: config.maxConcurrentSessions,
      unlimited: config.unlimited,
      sessionTtlMs: config.sessionTtlMs,
    });
  });
}

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('shutting down', { signal });
  server.close();
  await sessionManager.stop();
  await reapOrphans();
  process.exit(0);
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => log.error('unhandled rejection', { reason: String(reason) }));

void main();
