// Docker service source: the existing dockerode path, refactored to satisfy the
// common ServiceSource interface (list/inspect/start/stop/restart/logsStream).
// The legacy /containers routes still call dockerode directly and are untouched;
// this wraps the same connection so the unified /services view can treat Docker
// like any other source.

import { calcCpuPercent, calcMemUsage } from '../metrics.js';
import { assertVisible, visibleContainers } from '../hidden.js';
import { LogStream } from './exec.js';

// Map Docker's container State to the normalized Service status vocabulary.
function normalizeStatus(state) {
  switch (state) {
    case 'running':
      return 'running';
    case 'restarting':
      return 'restarting';
    case 'dead':
      return 'errored';
    case 'exited':
    case 'created':
    case 'paused':
    case 'removing':
      return 'stopped';
    default:
      return 'unknown';
  }
}

export class DockerSource {
  constructor(serverId, docker) {
    this.source = 'docker';
    this.serverId = serverId;
    this.docker = docker;
  }

  // Docker is always "available" as a source — if the daemon is unreachable the
  // individual calls fail and the route reports that per-source, same as today.
  async available() {
    return true;
  }

  async list() {
    // Containers matched by HIDDEN_CONTAINERS drop out here too, so the unified
    // /services view stays consistent with the Docker-only container list.
    const all = visibleContainers(await this.docker.listContainers({ all: true }));
    // Resource numbers need a stats read per container, which is the expensive
    // part. Only sample running containers; stopped ones report null.
    const samples = await Promise.all(
      all.map(async (c) => {
        if (c.State !== 'running') return null;
        try {
          const stats = await this.docker.getContainer(c.Id).stats({ stream: false });
          return { cpuPct: calcCpuPercent(stats), memBytes: calcMemUsage(stats).used };
        } catch (_) {
          return null;
        }
      })
    );
    return all.map((c, i) => ({
      id: c.Id,
      name: (c.Names[0] || '').replace(/^\//, ''),
      source: 'docker',
      status: normalizeStatus(c.State),
      rawStatus: c.Status,
      cpuPct: samples[i] ? round2(samples[i].cpuPct) : null,
      memBytes: samples[i] ? samples[i].memBytes : null,
      uptimeMs: null, // available via inspect (State.StartedAt); omitted from list
      restarts: null, // available via inspect (RestartCount); omitted from list
      pid: null,
    }));
  }

  async inspect(id) {
    await assertVisible(this.docker, id);
    return this.docker.getContainer(id).inspect();
  }

  async start(id) {
    await assertVisible(this.docker, id);
    await this.docker.getContainer(id).start();
    return { ok: true, message: 'started' };
  }

  async stop(id) {
    await assertVisible(this.docker, id);
    await this.docker.getContainer(id).stop();
    return { ok: true, message: 'stopped' };
  }

  async restart(id) {
    await assertVisible(this.docker, id);
    await this.docker.getContainer(id).restart();
    return { ok: true, message: 'restarted' };
  }

  // Wraps the dockerode multiplexed log stream into a normalized LogStream.
  // Mirrors the framing logic in routes/docker.js so both views behave the same.
  async logsStream(id, { tail = 200, follow = true } = {}) {
    const stream = new LogStream();
    let raw;
    try {
      await assertVisible(this.docker, id);
      raw = await this.docker.getContainer(id).logs({
        follow,
        stdout: true,
        stderr: true,
        tail,
        timestamps: false,
      });
    } catch (err) {
      queueMicrotask(() => stream.emit('error', err));
      return stream;
    }

    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Docker multiplexes stdout/stderr with an 8-byte header per frame.
      while (buffer.length >= 8) {
        const size = buffer.readUInt32BE(4);
        if (buffer.length < 8 + size) break;
        const payload = buffer.slice(8, 8 + size).toString('utf8');
        buffer = buffer.slice(8 + size);
        const ts = Date.now();
        payload.split(/\r?\n/).forEach((l) => {
          if (l.length) stream.emitLine(ts, l);
        });
      }
    };

    raw.on('data', onData);
    raw.on('end', () => stream.emit('end'));
    raw.on('error', (err) => stream.emit('error', err));
    stream.onClose(() => {
      try {
        raw.destroy();
      } catch (_) {
        /* already gone */
      }
    });
    return stream;
  }
}

function round2(n) {
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100) / 100;
}
