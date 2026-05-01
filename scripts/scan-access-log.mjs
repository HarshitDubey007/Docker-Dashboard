#!/usr/bin/env node
import fs from 'fs';
import readline from 'readline';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const LOG = args.log;
const BLOCKLIST = args.blocklist;
const REQ_THRESHOLD = Number(args['req-threshold'] || 10000);
const AUTH_FAIL_THRESHOLD = Number(args['auth-fail-threshold'] || 50);
const RATE_HIT_THRESHOLD = Number(args['rate-hit-threshold'] || 100);
const TTL_HOURS = Number(args['ttl-hours'] || 24);
const WINDOW_HOURS = Number(args['window-hours'] || 24);

if (!LOG || !BLOCKLIST) {
  console.error('usage: scan-access-log.mjs --log <path> --blocklist <path> [--req-threshold N] [--auth-fail-threshold N] [--rate-hit-threshold N] [--ttl-hours H] [--window-hours H]');
  process.exit(2);
}

const SINCE = Date.now() - WINDOW_HOURS * 60 * 60 * 1000;

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^::1$/,
  /^fc/i,
  /^fd/i,
];
const isPrivate = (ip) => !ip || PRIVATE_RANGES.some((r) => r.test(String(ip).replace(/^::ffff:/, '')));

if (!fs.existsSync(LOG)) {
  console.log(`scan: no log file at ${LOG} — nothing to do`);
  process.exit(0);
}

const stats = new Map();
let scanned = 0;
let outOfWindow = 0;

const rl = readline.createInterface({
  input: fs.createReadStream(LOG, { encoding: 'utf8' }),
  crlfDelay: Infinity,
});

await new Promise((resolve, reject) => {
  rl.on('line', (line) => {
    if (!line) return;
    let r;
    try { r = JSON.parse(line); } catch { return; }
    if (!r.t || !r.ip) return;
    if (new Date(r.t).getTime() < SINCE) { outOfWindow++; return; }
    if (isPrivate(r.ip)) return;
    scanned++;
    let s = stats.get(r.ip);
    if (!s) { s = { total: 0, authFail: 0, rateHit: 0 }; stats.set(r.ip, s); }
    s.total++;
    if (r.s === 401) s.authFail++;
    if (r.s === 429) s.rateHit++;
  });
  rl.on('close', resolve);
  rl.on('error', reject);
});

const flagged = [];
for (const [ip, s] of stats) {
  const reasons = [];
  if (s.total > REQ_THRESHOLD) reasons.push(`req=${s.total}`);
  if (s.authFail > AUTH_FAIL_THRESHOLD) reasons.push(`authFail=${s.authFail}`);
  if (s.rateHit > RATE_HIT_THRESHOLD) reasons.push(`rateHit=${s.rateHit}`);
  if (reasons.length) flagged.push({ ip, reason: reasons.join(','), stats: s });
}

let existing = { blocked: [] };
try { existing = JSON.parse(fs.readFileSync(BLOCKLIST, 'utf8')); } catch {}
existing.blocked = existing.blocked || [];

const now = new Date();
const expiresAt = new Date(now.getTime() + TTL_HOURS * 3600 * 1000);

const byIp = new Map(existing.blocked.map((e) => [e.ip, e]));
const initialCount = byIp.size;

let added = 0;
let refreshed = 0;
for (const f of flagged) {
  const prev = byIp.get(f.ip);
  if (prev) {
    prev.reason = f.reason;
    prev.expiresAt = expiresAt.toISOString();
    refreshed++;
  } else {
    byIp.set(f.ip, {
      ip: f.ip,
      reason: f.reason,
      blockedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });
    added++;
  }
}

const merged = [...byIp.values()].filter((e) => !e.expiresAt || new Date(e.expiresAt).getTime() > now.getTime());
const expired = initialCount + added - merged.length;

fs.writeFileSync(BLOCKLIST, JSON.stringify({ blocked: merged }, null, 2));

console.log(`scan: scanned=${scanned} out-of-window=${outOfWindow} unique-ips=${stats.size} flagged=${flagged.length} added=${added} refreshed=${refreshed} expired-removed=${expired} active=${merged.length}`);
for (const f of flagged) {
  console.log(`  flag ${f.ip} ${f.reason} (total=${f.stats.total} authFail=${f.stats.authFail} rateHit=${f.stats.rateHit})`);
}
