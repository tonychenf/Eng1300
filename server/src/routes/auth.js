import { Router } from 'express';
import { getUserByUsername, touchLastLogin } from '../db.js';
import { verifyPassword, signToken } from '../auth.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username_and_password_required' });
  }

  const user = getUserByUsername(username);
  if (!user) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }
  if (user.disabled) {
    return res.status(403).json({ error: 'account_disabled' });
  }

  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) {
    return res.status(401).json({ error: 'invalid_credentials' });
  }

  touchLastLogin(user.id);
  const token = signToken(user);
  res.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
});
