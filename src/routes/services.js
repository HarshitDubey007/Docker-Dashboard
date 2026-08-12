// Unified service routes — a superset of the Docker-only /containers routes that
// merges every source (docker, pm2, systemd) behind one shape. The legacy
// /containers routes in docker.js are left untouched.
//
// Read access (list / inspect / logs) is scoped for non-admins to their assigned
// services. Control actions (start/stop/restart) are admin-only and audited, per
// the security requirements — viewers get read-only access here.

import express from 'express';
import { db } from '../db.js';
import { requireAuth, requireAdmin } from '../auth.js';
import serverManager from '../serverManager.js';
import { auditControl } from '../audit.js';

const router = express.Router({ mergeParams: true });

function resolveServer(req, res, next) {
  const server = db.data.servers.find((s) => s.id === req.params.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  req.server = server;
  try {
    req.sources = serverManager.getSourcesForServer(server.id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  next();
}

function getSource(req, res) {
  const src = req.sources[req.params.source];
  if (!src) {
    res.status(404).json({ error: `Unknown or unavailable source: ${req.params.source}` });
    return null;
  }
  return src;
}

// A viewer may see a service if it is explicitly assigned. Docker containers
// fall back to the existing assignedContainers model for backward compatibility;
// all sources honor the newer assignedServices model.
function canAccessService(user, serverId, source, id) {
  if (user.role === 'admin') return true;
  if (source === 'docker') {
    const ok = (user.assignedContainers || []).some(
      (a) => a.serverId === serverId && a.containerId === id
    );
    if (ok) return true;
  }
  return (user.assignedServices || []).some(
    (a) => a.serverId === serverId && a.source === source && a.id === id
  );
}

router.use(requireAuth, resolveServer);

// GET /services — list across all available sources, scoped for non-admins.
// Per-source failures are reported in `sources[]` rather than failing the request.
router.get('/services', async (req, res) => {
  const services = [];
  const sourceMeta = [];
  for (const [name, src] of Object.entries(req.sources)) {
    let available = true;
    try {
      available = await src.available();
    } catch (_) {
      available = false;
    }
    if (!available) {
      sourceMeta.push({ name, available: false });
      continue;
    }
    try {
      const list = await src.list();
      services.push(...list);
      sourceMeta.push({ name, available: true, count: list.length });
    } catch (err) {
      sourceMeta.push({ name, available: true, error: err.message });
    }
  }
  const scoped =
    req.user.role === 'admin'
      ? services
      : services.filter((s) => canAccessService(req.user, req.server.id, s.source, s.id));
  res.json({ services: scoped, sources: sourceMeta });
});

router.get('/services/:source/:id/inspect', async (req, res) => {
  const src = getSource(req, res);
  if (!src) return;
  if (!canAccessService(req.user, req.server.id, req.params.source, req.params.id)) {
    return res.status(403).json({ error: 'Access denied for this service' });
  }
  try {
    const detail = await src.inspect(req.params.id);
    res.json(detail);
  } catch (err) {
    // err.statusCode is set for hidden services (404) — see hidden.js.
    res.status(err.statusCode || 502).json({ error: err.message });
  }
});

router.get('/services/:source/:id/logs', async (req, res) => {
  const src = getSource(req, res);
  if (!src) return;
  if (!canAccessService(req.user, req.server.id, req.params.source, req.params.id)) {
    return res.status(403).json({ error: 'Access denied for this service' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  let stream;
  try {
    stream = await src.logsStream(req.params.id, { tail: 200, follow: true });
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    return res.end();
  }

  stream.on('data', ({ ts, line }) => {
    res.write(`data: ${JSON.stringify({ ts, line })}\n\n`);
  });
  stream.on('error', (err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
  });
  stream.on('end', () => {
    res.write('event: end\ndata: {}\n\n');
    res.end();
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(heartbeat);
    stream.close();
  });
});

async function serviceAction(req, res, action) {
  const src = getSource(req, res);
  if (!src) return;
  const { source, id } = req.params;
  let result;
  try {
    result = await src[action](id);
  } catch (err) {
    result = { ok: false, message: err.message, status: err.statusCode };
  }
  auditControl({
    user: req.user,
    ip: req.ip,
    serverId: req.server.id,
    source,
    target: id,
    action,
    result: result.ok ? 'ok' : 'error',
    message: result.ok ? null : result.message,
  });
  if (!result.ok) {
    return res.status(result.status || 502).json({ error: result.message || 'Action failed' });
  }
  res.json({ ok: true, message: result.message });
}

router.post('/services/:source/:id/start', requireAdmin, (req, res) =>
  serviceAction(req, res, 'start')
);
router.post('/services/:source/:id/stop', requireAdmin, (req, res) =>
  serviceAction(req, res, 'stop')
);
router.post('/services/:source/:id/restart', requireAdmin, (req, res) =>
  serviceAction(req, res, 'restart')
);

export default router;
