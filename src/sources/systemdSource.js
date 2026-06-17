// systemd service source (local host-access mode).
//
// Reads units with `systemctl ... --output=json`, enriches running units with
// `systemctl show` for resource usage, and streams logs from `journalctl -o json`.
// Control actions (start/stop/restart) need root or a narrow polkit policy — see
// the README security section. We keep a per-unit CPU sample so successive list()
// calls can derive a CPU percentage from the monotonic CPUUsageNSec counter.

import { runCommand, commandAvailable, spawnLogStream, isSafeId } from './exec.js';

const SHOW_PROPS = [
  'ActiveState',
  'SubState',
  'MemoryCurrent',
  'CPUUsageNSec',
  'MainPID',
  'ExecMainStartTimestamp',
];

function normalizeStatus(active, sub) {
  if (active === 'failed') return 'errored';
  // 'active' covers both long-running (sub=running) and finished oneshot
  // (sub=exited) units; both count as up for our purposes.
  if (active === 'active') return 'running';
  if (active === 'activating' || active === 'deactivating') return 'restarting';
  if (active === 'inactive') return 'stopped';
  return 'unknown';
}

// systemctl reports unset numeric properties as the literal [not set] / empty.
function parseNum(value) {
  if (value == null || value === '' || value === '[not set]') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export class SystemdSource {
  constructor() {
    this.source = 'systemd';
    // unit -> { nsec, t } previous CPU sample, for delta-based CPU%.
    this._cpuSamples = new Map();
  }

  available() {
    return commandAvailable('systemctl');
  }

  async list() {
    const { stdout } = await runCommand('systemctl', [
      'list-units',
      '--type=service',
      '--all',
      '--output=json',
      '--no-pager',
    ]);
    let units;
    try {
      units = JSON.parse(stdout || '[]');
    } catch (_) {
      units = [];
    }

    const now = Date.now();
    const services = units.map((u) => ({
      id: u.unit,
      name: String(u.unit).replace(/\.service$/, ''),
      source: 'systemd',
      status: normalizeStatus(u.active, u.sub),
      rawStatus: `${u.active} (${u.sub})`,
      cpuPct: null,
      memBytes: null,
      uptimeMs: null,
      restarts: null,
      pid: null,
    }));

    // Enrich only active units — `systemctl show` is a fork per unit and stopped
    // services have nothing useful to sample.
    const active = services.filter((s) => s.status === 'running' || s.status === 'restarting');
    await Promise.all(
      active.map(async (svc) => {
        try {
          const detail = await this._show(svc.id);
          svc.memBytes = detail.memBytes;
          svc.pid = detail.pid;
          svc.uptimeMs = detail.uptimeMs;
          svc.cpuPct = this._cpuPercent(svc.id, detail.cpuNSec, now);
        } catch (_) {
          /* leave nulls if show fails (e.g. transient unit) */
        }
      })
    );
    return services;
  }

  async _show(unit) {
    const { stdout } = await runCommand('systemctl', [
      'show',
      unit,
      `--property=${SHOW_PROPS.join(',')}`,
      '--no-pager',
    ]);
    const props = {};
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      props[line.slice(0, eq)] = line.slice(eq + 1);
    }
    const startMs = props.ExecMainStartTimestamp
      ? Date.parse(props.ExecMainStartTimestamp)
      : NaN;
    return {
      memBytes: parseNum(props.MemoryCurrent),
      cpuNSec: parseNum(props.CPUUsageNSec),
      pid: parseNum(props.MainPID),
      uptimeMs: Number.isFinite(startMs) ? Date.now() - startMs : null,
    };
  }

  // CPUUsageNSec is a cumulative counter. Percent of one core over the interval
  // since the last sample = ΔCPU_ns / Δwall_ns * 100. First sample returns null.
  _cpuPercent(unit, cpuNSec, now) {
    if (cpuNSec == null) return null;
    const prev = this._cpuSamples.get(unit);
    this._cpuSamples.set(unit, { nsec: cpuNSec, t: now });
    if (!prev) return null;
    const wallNs = (now - prev.t) * 1e6;
    if (wallNs <= 0) return null;
    const pct = ((cpuNSec - prev.nsec) / wallNs) * 100;
    return pct >= 0 ? Math.round(pct * 100) / 100 : null;
  }

  async inspect(id) {
    if (!isSafeId(id)) throw new Error('Invalid unit name');
    const { stdout } = await runCommand('systemctl', ['show', id, '--no-pager']);
    const props = {};
    for (const line of stdout.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return props;
  }

  async _action(id, verb) {
    if (!isSafeId(id)) throw new Error('Invalid unit name');
    try {
      await runCommand('systemctl', [verb, id]);
      return { ok: true, message: `${verb}ed` };
    } catch (err) {
      // Permission failures (missing root/polkit) land here with a clear stderr.
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
    if (!isSafeId(id)) throw new Error('Invalid unit name');
    const args = ['-u', id, '-o', 'json', '-n', String(tail), '--no-pager'];
    if (follow) args.push('-f');
    return spawnLogStream('journalctl', args, (raw) => {
      try {
        const obj = JSON.parse(raw);
        // __REALTIME_TIMESTAMP is microseconds since epoch.
        const us = Number(obj.__REALTIME_TIMESTAMP);
        const ts = Number.isFinite(us) ? Math.floor(us / 1000) : Date.now();
        let msg = obj.MESSAGE;
        // Binary messages arrive as a byte array; decode to text.
        if (Array.isArray(msg)) msg = Buffer.from(msg).toString('utf8');
        msg = msg == null ? '' : String(msg);
        if (!msg) return null;
        return { ts, line: msg };
      } catch (_) {
        return { ts: Date.now(), line: raw };
      }
    });
  }
}
