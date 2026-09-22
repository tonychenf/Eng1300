import { Router } from 'express';
import crypto from 'node:crypto';
import { requireAuth, requireRole } from '../middleware.js';
import {
  listUsers,
  createUser,
  getUserById,
  updatePasswordHash,
  setDisabled,
} from '../db.js';
import { hashPassword } from '../auth.js';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireRole('SUPER_ADMIN'));

function randomPassword() {
  return crypto.randomBytes(9).toString('base64url'); // 12-char, URL-safe
}

adminRouter.get('/users', (req, res) => {
  res.json({ users: listUsers() });
});

adminRouter.post('/users', async (req, res) => {
  const { username } = req.body || {};
  if (!username) {
    return res.status(400).json({ error: 'username_required' });
  }

  const password = req.body?.password || randomPassword();
  const passwordHash = await hashPassword(password);
  try {
    const user = createUser({ username, passwordHash, role: 'USER' });
    // Initial credentials are returned once here for the admin to hand to the
    // user; they are never retrievable again (only a reset creates a new one).
    res.status(201).json({
      user: { id: user.id, username: user.username, role: user.role },
      initialPassword: password,
    });
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'username_taken' });
    }
    throw err;
  }
});

adminRouter.post('/users/:id/reset-password', async (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not_found' });

  const password = req.body?.password || randomPassword();
  const passwordHash = await hashPassword(password);
  updatePasswordHash(user.id, passwordHash);
  res.json({ newPassword: password });
});

adminRouter.patch('/users/:id/status', (req, res) => {
  const user = getUserById(Number(req.params.id));
  if (!user) return res.status(404).json({ error: 'not_found' });
  if (user.role === 'SUPER_ADMIN') {
    return res.status(400).json({ error: 'cannot_disable_super_admin' });
  }

  const { disabled } = req.body || {};
  setDisabled(user.id, Boolean(disabled));
  res.json({ id: user.id, disabled: Boolean(disabled) });
});
