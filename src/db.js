import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { Low, JSONFile } from 'lowdb';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const adapter = new JSONFile(DB_FILE);
export const db = new Low(adapter);

export async function init() {
  await db.read();
  db.data = db.data || { users: [], servers: [] };
  db.data.users = db.data.users || [];
  db.data.servers = db.data.servers || [];

  const defaultPassword = process.env.DEFAULT_ADMIN_PASSWORD || 'admin123';
  if (db.data.users.length === 0) {
    db.data.users.push({
      id: uuid(),
      username: 'admin',
      password: bcrypt.hashSync(defaultPassword, 10),
      role: 'admin',
      assignedContainers: [],
      createdAt: new Date().toISOString(),
      lastLogin: null,
    });
    console.log(`[db] Bootstrapped default admin user (username: admin / password: ${defaultPassword})`);
  }

  const socketPath = '/var/run/docker.sock';
  const hasLocalSocket = fs.existsSync(socketPath);
  const existingLocal = db.data.servers.find((s) => s.id === 'local');
  if (hasLocalSocket && !existingLocal) {
    db.data.servers.unshift({
      id: 'local',
      name: 'Local Server',
      type: 'local',
      host: null,
      port: null,
      tls: false,
      tlsCert: null,
      tlsKey: null,
      tlsCa: null,
      status: 'unknown',
      lastChecked: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
    });
    console.log('[db] Local Docker socket detected — added "Local Server" entry');
  } else if (!hasLocalSocket && existingLocal) {
    db.data.servers = db.data.servers.filter((s) => s.id !== 'local');
    console.log('[db] Local Docker socket missing — removed "Local Server" entry');
  }

  await db.write();
}

export async function save() {
  await db.write();
}
