import express from 'express';
import { db } from '../db.js';
import { requireAuth } from '../auth.js';
import serverManager from '../serverManager.js';
import { summarizeContainer, summarizeHost } from '../metrics.js';

const router = express.Router({ mergeParams: true });

function resolveServer(req, res, next) {
  const server = db.data.servers.find((s) => s.id === req.params.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  req.server = server;
  try {
    req.docker = serverManager.getDockerForServer(server.id);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  next();
}

function canAccessContainer(user, serverId, containerId) {
  if (user.role === 'admin') return true;
  const list = user.assignedContainers || [];
  return list.some((a) => a.serverId === serverId && a.containerId === containerId);
}

router.use(requireAuth, resolveServer);

router.get('/info', async (req, res) => {
  try {
    const info = await req.docker.info();
    const version = await req.docker.version();
    res.json({
      name: req.server.name,
      serverId: req.server.id,
      docker: {
        version: version.Version,
        apiVersion: version.ApiVersion,
        os: info.OperatingSystem || info.OSType,
        arch: info.Architecture,
        kernel: info.KernelVersion,
        containers: info.Containers,
        containersRunning: info.ContainersRunning,
        containersStopped: info.ContainersStopped,
        images: info.Images,
        cpus: info.NCPU,
        memory: info.MemTotal,
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

async function collectSamples(docker, { userFilterIds = null } = {}) {
  const info = await docker.info();
  const running = await docker.listContainers({ all: false });
  const targets = userFilterIds
    ? running.filter((c) => userFilterIds.has(c.Id))
    : running;
  const samples = await Promise.all(
    targets.map(async (c) => {
      try {
        const stats = await docker.getContainer(c.Id).stats({ stream: false });
        const name = (c.Names[0] || '').replace(/^\//, '');
        return summarizeContainer(c.Id, name, stats);
      } catch (_) {
        return null;
      }
    })
  );
  return { info, samples: samples.filter(Boolean) };
}

function allowedContainerIds(user, serverId) {
  if (user.role === 'admin') return null;
  return new Set(
    (user.assignedContainers || [])
      .filter((a) => a.serverId === serverId)
      .map((a) => a.containerId)
  );
}

router.get('/stats', async (req, res) => {
  try {
    const filter = allowedContainerIds(req.user, req.server.id);
    const { info, samples } = await collectSamples(req.docker, { userFilterIds: filter });
    res.json({ host: summarizeHost(info, samples), containers: samples });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/containers/:id/stats', async (req, res) => {
  if (!canAccessContainer(req.user, req.server.id, req.params.id)) {
    return res.status(403).json({ error: 'Access denied for this container' });
  }
  try {
    const container = req.docker.getContainer(req.params.id);
    const inspect = await container.inspect();
    const name = (inspect.Name || '').replace(/^\//, '');
    const stats = await container.stats({ stream: false });
    res.json(summarizeContainer(req.params.id, name, stats));
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/metrics/stream', async (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const filter = allowedContainerIds(req.user, req.server.id);
  let closed = false;
  req.on('close', () => { closed = true; });

  const tick = async () => {
    if (closed) return;
    try {
      const { info, samples } = await collectSamples(req.docker, { userFilterIds: filter });
      if (closed) return;
      const payload = {
        ts: Date.now(),
        host: summarizeHost(info, samples),
        containers: samples,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (err) {
      if (closed) return;
      res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    }
  };

  await tick();
  const interval = setInterval(tick, 2000);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(interval);
    clearInterval(heartbeat);
  });
});

router.get('/containers', async (req, res) => {
  try {
    const all = await req.docker.listContainers({ all: true });
    const shaped = all.map((c) => ({
      id: c.Id,
      shortId: c.Id.slice(0, 12),
      names: c.Names.map((n) => n.replace(/^\//, '')),
      name: (c.Names[0] || '').replace(/^\//, ''),
      image: c.Image,
      imageId: c.ImageID,
      state: c.State,
      status: c.Status,
      created: c.Created,
      ports: c.Ports || [],
      labels: c.Labels || {},
    }));
    let filtered = shaped;
    if (req.user.role !== 'admin') {
      const allowed = new Set(
        (req.user.assignedContainers || [])
          .filter((a) => a.serverId === req.server.id)
          .map((a) => a.containerId)
      );
      filtered = shaped.filter((c) => allowed.has(c.id));
    }
    res.json({ containers: filtered });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/containers/:id/inspect', async (req, res) => {
  if (!canAccessContainer(req.user, req.server.id, req.params.id)) {
    return res.status(403).json({ error: 'Access denied for this container' });
  }
  try {
    const container = req.docker.getContainer(req.params.id);
    const data = await container.inspect();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

router.get('/containers/:id/logs', async (req, res) => {
  if (!canAccessContainer(req.user, req.server.id, req.params.id)) {
    return res.status(403).json({ error: 'Access denied for this container' });
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();

  const container = req.docker.getContainer(req.params.id);
  let logStream;
  try {
    logStream = await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail: 200,
      timestamps: false,
    });
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    return res.end();
  }

  const sendLine = (line) => {
    if (!line) return;
    const payload = JSON.stringify({ line });
    res.write(`data: ${payload}\n\n`);
  };

  let buffer = Buffer.alloc(0);
  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 8) {
      const size = buffer.readUInt32BE(4);
      if (buffer.length < 8 + size) break;
      const payload = buffer.slice(8, 8 + size).toString('utf8');
      buffer = buffer.slice(8 + size);
      payload.split(/\r?\n/).forEach((l) => {
        if (l.length) sendLine(l);
      });
    }
  };

  logStream.on('data', onData);
  logStream.on('end', () => {
    res.write(`event: end\ndata: {}\n\n`);
    res.end();
  });
  logStream.on('error', (err) => {
    res.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  });

  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    try { logStream.destroy(); } catch (_) {}
  });
});

async function containerAction(req, res, action) {
  if (!canAccessContainer(req.user, req.server.id, req.params.id)) {
    return res.status(403).json({ error: 'Access denied for this container' });
  }
  try {
    const container = req.docker.getContainer(req.params.id);
    await container[action]();
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
}

router.post('/containers/:id/start', (req, res) => containerAction(req, res, 'start'));
router.post('/containers/:id/stop', (req, res) => containerAction(req, res, 'stop'));
router.post('/containers/:id/restart', (req, res) => containerAction(req, res, 'restart'));

export default router;
