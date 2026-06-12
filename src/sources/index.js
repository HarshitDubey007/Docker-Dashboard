// Source registry. Builds the set of ServiceSource instances a server exposes.
//
// Docker is always present (local socket or remote daemon). PM2 and systemd are
// host-level: in `local` host-access mode they only make sense on the server the
// dashboard process actually runs on (`type === 'local'`) — a container with just
// docker.sock mounted cannot reach them. `agent` host-access mode (a remote agent
// exposing the same ServiceSource methods over HTTP) is a later phase; it will
// slot in here without touching callers.
//
// Operators can force-disable the host-level sources with PM2_ENABLED=0 /
// SYSTEMD_ENABLED=0 (e.g. when the dashboard runs containerized).

import { DockerSource } from './dockerSource.js';
import { Pm2Source } from './pm2Source.js';
import { SystemdSource } from './systemdSource.js';

function enabled(envVar) {
  const v = process.env[envVar];
  return v === undefined || !/^(0|false|no)$/i.test(v);
}

export function buildSources(server, docker) {
  const sources = { docker: new DockerSource(server.id, docker) };
  if (server.type === 'local') {
    if (enabled('PM2_ENABLED')) sources.pm2 = new Pm2Source();
    if (enabled('SYSTEMD_ENABLED')) sources.systemd = new SystemdSource();
  }
  return sources;
}
