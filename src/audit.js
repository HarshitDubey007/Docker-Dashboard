// Audit log for control actions (start/stop/restart on any service source).
// Append-only NDJSON, same shape and rationale as the access log in security.js:
// keeping it out of db.json avoids unbounded growth of the config store and a
// future "Audit log UI" can tail this file. We record who/what/where/when/result
// and never log secrets (tokens, env values, TLS keys are never passed in here).

import path from 'path';
import fs from 'fs';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const AUDIT_LOG = path.join(DATA_DIR, 'audit.log');

export function auditControl({ user, ip, serverId, source, target, action, result, message }) {
  const line = JSON.stringify({
    t: new Date().toISOString(),
    user: user?.username || null,
    role: user?.role || null,
    ip: ip || null,
    server: serverId || null,
    source: source || null,
    target: target || null,
    action: action || null,
    result: result || null, // 'ok' | 'error'
    msg: message ? String(message).slice(0, 500) : null,
  });
  fs.appendFile(AUDIT_LOG, line + '\n', (err) => {
    if (err) console.error('[audit] write failed:', err.message);
  });
}
