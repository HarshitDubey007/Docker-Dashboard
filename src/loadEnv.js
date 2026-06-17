// Minimal .env loader so the app is turnkey when run natively on a host
// (`npm start` / `./start.sh`) without exporting variables by hand. No external
// dependency — a few lines beat pulling in dotenv.
//
// Rules: real process.env always wins over .env (so Docker/compose-injected env
// is never overridden), missing .env is fine (the container path has none — env
// comes from compose), `#` comments and blank lines are skipped, an optional
// leading `export` and surrounding quotes are tolerated.
//
// Imported for its side effect, FIRST, before any module that reads env at load
// time (auth.js → JWT_SECRET, db.js → DATA_DIR, etc.). ESM evaluates imported
// modules in source order, so importing this first guarantees env is populated
// before those modules are evaluated.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = process.env.ENV_FILE || path.join(__dirname, '..', '.env');

try {
  const raw = fs.readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue; // comments and blank lines never match
    const key = m[1];
    if (process.env[key] !== undefined) continue; // do not clobber real env
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
} catch (err) {
  if (err.code !== 'ENOENT') console.error('[env] failed to load .env:', err.message);
}
