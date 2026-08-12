import express from 'express';
import { v4 as uuid } from 'uuid';
import { db, save } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import serverManager from '../serverManager.js';
import { visibleCounts } from '../hidden.js';

const router = express.Router();

function sanitizeServer(s, extras = {}) {
  return {
    id: s.id,
    name: s.name,
    type: s.type,
    host: s.host,
    port: s.port,
    tls: !!s.tls,
    hasTlsCert: !!s.tlsCert,
    hasTlsKey: !!s.tlsKey,
    hasTlsCa: !!s.tlsCa,
    status: s.status,
    lastChecked: s.lastChecked,
    errorMessage: s.errorMessage,
    createdAt: s.createdAt,
    ...extras,
  };
}

router.get('/', requireAuth, async (req, res) => {
  const servers = db.data.servers;
  const enriched = await Promise.all(
    servers.map(async (s) => {
      const extras = {};
      if (s.status === 'connected') {
        try {
          const docker = serverManager.getDockerForServer(s.id);
          const info = await docker.info();
          const counts = await visibleCounts(docker, info);
          extras.containerCount = counts.total;
          extras.containersRunning = counts.running;
          extras.version = info.ServerVersion;
          extras.os = info.OperatingSystem || info.OSType;
        } catch (err) {
          /* swallow; status is cached */
        }
      }
      return sanitizeServer(s, extras);
    })
  );
  res.json({ servers: enriched });
});

router.post('/', requireAuth, requireAdmin, async (req, res) => {
  const { name, host, port, tls, tlsCert, tlsKey, tlsCa } = req.body || {};
  if (!name || !host) {
    return res.status(400).json({ error: 'Name and host are required' });
  }
  const server = {
    id: uuid(),
    name: String(name).trim(),
    type: 'remote',
    host: String(host).trim(),
    port: Number(port) || (tls ? 2376 : 2375),
    tls: !!tls,
    tlsCert: tlsCert || null,
    tlsKey: tlsKey || null,
    tlsCa: tlsCa || null,
    status: 'unknown',
    lastChecked: null,
    errorMessage: null,
    createdAt: new Date().toISOString(),
  };
  db.data.servers.push(server);
  await save();
  const result = await serverManager.testConnection(server.id);
  res.status(201).json({ server: sanitizeServer(server), test: result });
});

router.post('/test', requireAuth, requireAdmin, async (req, res) => {
  const { host, port, tls, tlsCert, tlsKey, tlsCa } = req.body || {};
  if (!host) return res.status(400).json({ error: 'Host is required' });
  const ephemeral = {
    type: 'remote',
    host,
    port: Number(port) || (tls ? 2376 : 2375),
    tls: !!tls,
    tlsCert,
    tlsKey,
    tlsCa,
  };
  const result = await serverManager.testConnection(null, { persist: false, ephemeralConfig: ephemeral });
  res.json(result);
});

router.put('/:id', requireAuth, requireAdmin, async (req, res) => {
  const server = db.data.servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.type === 'local') {
    return res.status(400).json({ error: 'Local server cannot be edited' });
  }
  const { name, host, port, tls, tlsCert, tlsKey, tlsCa } = req.body || {};
  if (name !== undefined) server.name = String(name).trim();
  if (host !== undefined) server.host = String(host).trim();
  if (port !== undefined) server.port = Number(port) || server.port;
  if (tls !== undefined) server.tls = !!tls;
  if (tlsCert !== undefined) server.tlsCert = tlsCert || null;
  if (tlsKey !== undefined) server.tlsKey = tlsKey || null;
  if (tlsCa !== undefined) server.tlsCa = tlsCa || null;
  serverManager.invalidateConnection(server.id);
  await save();
  const result = await serverManager.testConnection(server.id);
  res.json({ server: sanitizeServer(server), test: result });
});

router.delete('/:id', requireAuth, requireAdmin, async (req, res) => {
  const server = db.data.servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (server.type === 'local') {
    return res.status(400).json({ error: 'Local server cannot be deleted' });
  }
  db.data.servers = db.data.servers.filter((s) => s.id !== server.id);
  serverManager.invalidateConnection(server.id);
  for (const user of db.data.users) {
    if (!user.assignedContainers) continue;
    user.assignedContainers = user.assignedContainers.filter(
      (a) => a.serverId !== server.id
    );
  }
  await save();
  res.json({ ok: true });
});

router.post('/:id/test', requireAuth, requireAdmin, async (req, res) => {
  const server = db.data.servers.find((s) => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  const result = await serverManager.testConnection(server.id);
  res.json(result);
});

router.get('/status/stream', requireAuth, (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const initial = db.data.servers.map((s) => ({
    serverId: s.id,
    status: s.status,
    lastChecked: s.lastChecked,
    error: s.errorMessage,
  }));
  res.write(`event: snapshot\ndata: ${JSON.stringify(initial)}\n\n`);

  const onStatus = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  serverManager.on('status', onStatus);

  const heartbeat = setInterval(() => {
    res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    serverManager.off('status', onStatus);
  });
});

export default router;
