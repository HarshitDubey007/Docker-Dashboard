// PM2 service source (local host-access mode).
//
// We shell out to the `pm2` CLI rather than importing PM2's programmatic API on
// purpose: the `pm2` npm package is very large and would dominate this project's
// deliberately small, auditable dependency tree. The CLI is already required on
// any host actually running PM2, so this adds no new runtime dependency.
//
// Caveat: the PM2 daemon is per-user. The dashboard only sees the daemon of the
// OS user it runs as; apps managed by other users are invisible here. Documented
// as a known limitation — cross-user PM2 is out of scope for this phase.

import { runCommand, commandAvailable, spawnLogStream, isSafeId } from './exec.js';

function normalizeStatus(status) {
  switch (status) {
    case 'online':
      return 'running';
    case 'launching':
      return 'restarting';
    case 'stopping':
    case 'stopped':
      return 'stopped';
    case 'errored':
      return 'errored';
    default:
      return 'unknown';
  }
}

export class Pm2Source {
  constructor() {
    this.source = 'pm2';
  }

  available() {
    return commandAvailable('pm2');
  }

  async list() {
    const { stdout } = await runCommand('pm2', ['jlist']);
    let procs;
    try {
      procs = JSON.parse(stdout || '[]');
    } catch (_) {
      // `pm2 jlist` can emit a stray banner line before the JSON on some setups.
      const start = stdout.indexOf('[');
      procs = start >= 0 ? JSON.parse(stdout.slice(start)) : [];
    }
    const now = Date.now();
    return procs.map((p) => {
      const env = p.pm2_env || {};
      const monit = p.monit || {};
      const online = env.status === 'online';
      return {
        id: String(p.pm_id),
        name: p.name,
        source: 'pm2',
        status: normalizeStatus(env.status),
        rawStatus: env.status || 'unknown',
        cpuPct: typeof monit.cpu === 'number' ? monit.cpu : null,
        memBytes: typeof monit.memory === 'number' ? monit.memory : null,
        uptimeMs: online && env.pm_uptime ? Math.max(0, now - env.pm_uptime) : null,
        restarts: typeof env.restart_time === 'number' ? env.restart_time : null,
        pid: p.pid || null,
      };
    });
  }

  async inspect(id) {
    if (!isSafeId(id)) throw new Error('Invalid service id');
    const { stdout } = await runCommand('pm2', ['jlist']);
    const procs = JSON.parse(stdout || '[]');
    const proc = procs.find((p) => String(p.pm_id) === String(id));
    if (!proc) throw new Error(`PM2 process ${id} not found`);
    return proc;
  }

  async _action(id, verb) {
    if (!isSafeId(id)) throw new Error('Invalid service id');
    try {
      await runCommand('pm2', [verb, id]);
      return { ok: true, message: `${verb}ed` };
    } catch (err) {
      return { ok: false, message: err.stderr || err.message };
    }
  }

  start(id) {
    return this._action(id, 'start');
  }

  stop(id) {
    return this._action(id, 'stop');
  }

  restart(id) {
    return this._action(id, 'restart');
  }

  logsStream(id, { tail = 200, follow = true } = {}) {
    if (!isSafeId(id)) throw new Error('Invalid service id');
    const args = ['logs', id, '--json', '--lines', String(tail)];
    if (!follow) args.push('--nostream');
    return spawnLogStream('pm2', args, (raw) => {
      try {
        const obj = JSON.parse(raw);
        const ts = obj.timestamp ? new Date(obj.timestamp).getTime() : Date.now();
        const line = String(obj.message ?? '').replace(/\n$/, '');
        if (!line) return null;
        return { ts: Number.isFinite(ts) ? ts : Date.now(), line };
      } catch (_) {
        // Non-JSON banner / framing lines from pm2 — pass through raw.
        return { ts: Date.now(), line: raw };
      }
    });
  }
}
