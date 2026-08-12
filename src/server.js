import './loadEnv.js'; // MUST be first — populates process.env before modules below read it
import path from 'path';
import { fileURLToPath } from 'url';
import express from 'express';
import cors from 'cors';

import { init } from './db.js';
import serverManager from './serverManager.js';
import { router as authRouter } from './auth.js';
import serversRouter from './routes/servers.js';
import dockerRouter from './routes/docker.js';
import servicesRouter from './routes/services.js';
import usersRouter from './routes/users.js';
import { accessLogger, ipBlocklist, globalLimiter } from './security.js';
import { hiddenPatterns } from './hidden.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3006;

async function main() {
  await init();

  const app = express();
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback');
  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(accessLogger());
  app.use(ipBlocklist());
  app.use('/api', globalLimiter);

  app.use('/api/auth', authRouter);
  app.use('/api/servers', serversRouter);
  app.use('/api/servers/:serverId', dockerRouter);
  app.use('/api/servers/:serverId', servicesRouter);
  app.use('/api/users', usersRouter);

  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  app.use((err, req, res, next) => {
    console.error('[error]', err);
    res.status(500).json({ error: err.message || 'Internal server error' });
  });

  serverManager.startPolling(30060);

  const server = app.listen(PORT, () => {
    console.log(`[docker-dashboard] listening on http://0.0.0.0:${PORT}`);
    const hidden = hiddenPatterns();
    if (hidden.length) {
      console.log(`[docker-dashboard] hiding containers matching: ${hidden.join(', ')}`);
    }
  });

  const shutdown = () => {
    console.log('[docker-dashboard] shutting down...');
    serverManager.stopPolling();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
