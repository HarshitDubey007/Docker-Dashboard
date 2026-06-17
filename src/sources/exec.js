// Shared helpers for the host-access layer used by host-level service sources
// (PM2, systemd). Everything goes through execFile/spawn with argument arrays —
// never a shell string — so service ids coming from the API can't be used for
// shell injection. Callers must still validate ids (see isSafeId) to block
// argument-injection (e.g. an id that looks like a `--flag`).

import { execFile, spawn } from 'child_process';
import { EventEmitter } from 'events';

// Ids that reach a CLI as positional args. Must start alphanumeric so a value
// can never be mistaken for an option flag, then allow the characters real
// container ids / pm2 names / systemd unit names use.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9@._:\-]*$/;

export function isSafeId(id) {
  return typeof id === 'string' && id.length <= 256 && SAFE_ID.test(id);
}

export function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: 15000, ...opts },
      (err, stdout, stderr) => {
        if (err) {
          // Surface stderr so callers can return an actionable message
          // (e.g. polkit/permission failures) instead of a bare exit code.
          err.stderr = (stderr || '').trim();
          reject(err);
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

// Cache binary availability — `which` is a fork we don't want on every list().
const availabilityCache = new Map();

export async function commandAvailable(cmd) {
  if (availabilityCache.has(cmd)) return availabilityCache.get(cmd);
  const ok = await runCommand('which', [cmd])
    .then(() => true)
    .catch(() => false);
  availabilityCache.set(cmd, ok);
  return ok;
}

// A normalized log stream every source returns from logsStream(). Consumers
// listen for 'data' ({ ts, line }), 'error' (Error), and 'end', and call
// close() to stop. This maps 1:1 onto the existing SSE pattern in the routes.
export class LogStream extends EventEmitter {
  constructor() {
    super();
    this._closed = false;
    this._onClose = null;
  }

  onClose(fn) {
    this._onClose = fn;
  }

  emitLine(ts, line) {
    if (this._closed) return;
    this.emit('data', { ts, line });
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    try {
      this._onClose?.();
    } catch (_) {
      /* best effort */
    }
  }
}

// Spawn a long-running command and turn its stdout into line events on a
// LogStream. `mapLine(raw)` returns { ts, line } (or null to drop the line).
export function spawnLogStream(cmd, args, mapLine) {
  const stream = new LogStream();
  let child;
  try {
    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    queueMicrotask(() => stream.emit('error', err));
    return stream;
  }

  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!raw.length) continue;
      const mapped = mapLine(raw);
      if (mapped) stream.emitLine(mapped.ts, mapped.line);
    }
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 4096) stderr = stderr.slice(-4096);
  });

  child.on('error', (err) => stream.emit('error', err));
  child.on('close', (code) => {
    if (code && code !== 0 && stderr.trim()) {
      stream.emit('error', new Error(stderr.trim()));
    }
    stream.emit('end');
  });

  stream.onClose(() => {
    try {
      child.kill('SIGTERM');
    } catch (_) {
      /* already gone */
    }
  });
  return stream;
}
