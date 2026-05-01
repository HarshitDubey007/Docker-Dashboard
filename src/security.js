import path from 'path';
import fs from 'fs';
import rateLimit from 'express-rate-limit';

const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const ACCESS_LOG = path.join(DATA_DIR, 'access.log');
const BLOCKLIST_FILE = path.join(DATA_DIR, 'blocklist.json');

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^::1$/,
  /^fc/i,
  /^fd/i,
];

export function isPrivateIp(ip) {
  if (!ip) return true;
  const cleaned = String(ip).replace(/^::ffff:/, '');
  return PRIVATE_RANGES.some((re) => re.test(cleaned));
}

export function accessLogger() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  return (req, res, next) => {
    const start = Date.now();
    res.on('finish', () => {
      const line = JSON.stringify({
        t: new Date().toISOString(),
        ip: req.ip,
        m: req.method,
        p: (req.originalUrl || req.url || '').split('?')[0],
        s: res.statusCode,
        d: Date.now() - start,
      });
      fs.appendFile(ACCESS_LOG, line + '\n', (err) => {
        if (err) console.error('[access-log] write failed:', err.message);
      });
    });
    next();
  };
}

let cachedSet = new Set();
let cachedMtime = -1;

function loadBlocklist() {
  try {
    const stat = fs.statSync(BLOCKLIST_FILE);
    if (stat.mtimeMs === cachedMtime) return cachedSet;
    const raw = fs.readFileSync(BLOCKLIST_FILE, 'utf8');
    const data = JSON.parse(raw);
    const now = Date.now();
    const set = new Set();
    for (const entry of data.blocked || []) {
      if (entry.expiresAt && new Date(entry.expiresAt).getTime() < now) continue;
      if (entry.ip) set.add(entry.ip);
    }
    cachedSet = set;
    cachedMtime = stat.mtimeMs;
    return set;
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[blocklist] load failed:', err.message);
    cachedSet = new Set();
    cachedMtime = -1;
    return cachedSet;
  }
}

export function ipBlocklist() {
  return (req, res, next) => {
    const set = loadBlocklist();
    if (set.size && set.has(req.ip)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

const GLOBAL_RATE_MAX = Number(process.env.GLOBAL_RATE_MAX) || 300;
const GLOBAL_RATE_WINDOW_MS = Number(process.env.GLOBAL_RATE_WINDOW_MS) || 60 * 1000;

export const globalLimiter = rateLimit({
  windowMs: GLOBAL_RATE_WINDOW_MS,
  max: GLOBAL_RATE_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded' },
});
