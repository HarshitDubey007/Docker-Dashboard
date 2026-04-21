import express from 'express';
import bcrypt from 'bcryptjs';
import { v4 as uuid } from 'uuid';
import { db, save } from '../db.js';
import { requireAuth, requireAdmin, publicUser } from '../auth.js';

const router = express.Router();

router.use(requireAuth, requireAdmin);

router.get('/', (req, res) => {
  res.json({ users: db.data.users.map(publicUser) });
});

router.post('/', async (req, res) => {
  const { username, password, role } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required' });
  }
  if (db.data.users.find((u) => u.username === username)) {
    return res.status(409).json({ error: 'Username already exists' });
  }
  const user = {
    id: uuid(),
    username: String(username).trim(),
    password: bcrypt.hashSync(password, 10),
    role: role === 'admin' ? 'admin' : 'viewer',
    assignedContainers: [],
    createdAt: new Date().toISOString(),
    lastLogin: null,
  };
  db.data.users.push(user);
  await save();
  res.status(201).json({ user: publicUser(user) });
});

router.put('/:id', async (req, res) => {
  const user = db.data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { username, password, role } = req.body || {};
  if (username !== undefined) {
    const exists = db.data.users.find((u) => u.username === username && u.id !== user.id);
    if (exists) return res.status(409).json({ error: 'Username already exists' });
    user.username = String(username).trim();
  }
  if (password) {
    user.password = bcrypt.hashSync(password, 10);
  }
  if (role !== undefined) {
    if (user.id === req.user.id && role !== 'admin') {
      return res.status(400).json({ error: 'You cannot demote yourself' });
    }
    user.role = role === 'admin' ? 'admin' : 'viewer';
  }
  await save();
  res.json({ user: publicUser(user) });
});

router.delete('/:id', async (req, res) => {
  const user = db.data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.user.id) {
    return res.status(400).json({ error: 'You cannot delete yourself' });
  }
  const admins = db.data.users.filter((u) => u.role === 'admin');
  if (user.role === 'admin' && admins.length === 1) {
    return res.status(400).json({ error: 'Cannot delete the last admin' });
  }
  db.data.users = db.data.users.filter((u) => u.id !== user.id);
  await save();
  res.json({ ok: true });
});

router.get('/:id/containers', (req, res) => {
  const user = db.data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ assignments: user.assignedContainers || [] });
});

router.put('/:id/containers', async (req, res) => {
  const user = db.data.users.find((u) => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { assignments } = req.body || {};
  if (!Array.isArray(assignments)) {
    return res.status(400).json({ error: 'assignments must be an array' });
  }
  const valid = assignments
    .filter((a) => a && typeof a.serverId === 'string' && typeof a.containerId === 'string')
    .map((a) => ({ serverId: a.serverId, containerId: a.containerId }));
  user.assignedContainers = valid;
  await save();
  res.json({ assignments: user.assignedContainers });
});

export default router;
