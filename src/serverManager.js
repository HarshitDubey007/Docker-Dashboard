import Docker from 'dockerode';
import { EventEmitter } from 'events';
import { db, save } from './db.js';
import { buildSources } from './sources/index.js';

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.sources = new Map();
    this.pollInterval = null;
  }

  buildDockerOptions(server) {
    if (server.type === 'local') {
      return { socketPath: '/var/run/docker.sock' };
    }
    const opts = {
      host: server.host,
      port: server.port || (server.tls ? 2376 : 2375),
    };
    if (server.tls) {
      opts.protocol = 'https';
      if (server.tlsCert) opts.cert = server.tlsCert;
      if (server.tlsKey) opts.key = server.tlsKey;
      if (server.tlsCa) opts.ca = server.tlsCa;
    } else {
      opts.protocol = 'http';
    }
    return opts;
  }

  getConnection(serverId) {
    const server = db.data.servers.find((s) => s.id === serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);
    if (this.connections.has(serverId)) return this.connections.get(serverId);
    const docker = new Docker(this.buildDockerOptions(server));
    this.connections.set(serverId, docker);
    return docker;
  }

  getDockerForServer(serverId) {
    return this.getConnection(serverId);
  }

  // Returns the cached map of service sources ({ docker, pm2?, systemd? }) for a
  // server. Cached because stateful sources (systemd keeps CPU samples between
  // list() calls to derive a percentage) must persist across requests.
  getSourcesForServer(serverId) {
    if (this.sources.has(serverId)) return this.sources.get(serverId);
    const server = db.data.servers.find((s) => s.id === serverId);
    if (!server) throw new Error(`Server ${serverId} not found`);
    const docker = this.getConnection(serverId);
    const built = buildSources(server, docker);
    this.sources.set(serverId, built);
    return built;
  }

  invalidateConnection(serverId) {
    this.connections.delete(serverId);
    // Sources hold a reference to the docker connection, so drop them too.
    this.sources.delete(serverId);
  }

  async testConnection(serverId, { persist = true, ephemeralConfig = null } = {}) {
    let docker;
    let server;
    if (ephemeralConfig) {
      server = ephemeralConfig;
      docker = new Docker(this.buildDockerOptions(ephemeralConfig));
    } else {
      server = db.data.servers.find((s) => s.id === serverId);
      if (!server) return { ok: false, error: 'Server not found' };
      docker = this.getConnection(serverId);
    }

    try {
      await docker.ping();
      const version = await docker.version();
      const info = await docker.info();
      const containerCount = info.Containers || 0;
      if (persist && server && !ephemeralConfig) {
        server.status = 'connected';
        server.lastChecked = new Date().toISOString();
        server.errorMessage = null;
        await save();
        this.emit('status', {
          serverId: server.id,
          status: 'connected',
          lastChecked: server.lastChecked,
          error: null,
        });
      }
      return {
        ok: true,
        version: version.Version,
        apiVersion: version.ApiVersion,
        os: info.OperatingSystem || info.OSType,
        containers: containerCount,
        containersRunning: info.ContainersRunning || 0,
      };
    } catch (err) {
      const msg = err.message || String(err);
      if (persist && server && !ephemeralConfig) {
        server.status = 'error';
        server.lastChecked = new Date().toISOString();
        server.errorMessage = msg;
        await save();
        this.connections.delete(serverId);
        this.emit('status', {
          serverId: server.id,
          status: 'error',
          lastChecked: server.lastChecked,
          error: msg,
        });
      }
      return { ok: false, error: msg };
    }
  }

  async testAllServers() {
    const servers = [...db.data.servers];
    await Promise.all(servers.map((s) => this.testConnection(s.id).catch(() => null)));
  }

  startPolling(intervalMs = 30000) {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.testAllServers().catch(() => {});
    this.pollInterval = setInterval(() => {
      this.testAllServers().catch(() => {});
    }, intervalMs);
  }

  stopPolling() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}

export default new ServerManager();
