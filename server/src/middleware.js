import { verifyToken } from './auth.js';
import { getUserById } from './db.js';

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'missing_token' });
  }
  try {
    const payload = verifyToken(token);
    const user = getUserById(payload.sub);
    if (!user || user.disabled) {
      return res.status(401).json({ error: 'account_disabled_or_missing' });
    }
    req.user = { id: user.id, username: user.username, role: user.role };
    next();
  } catch {
    return res.status(401).json({ error: 'invalid_or_expired_token' });
  }
}

export function requireRole(role) {
  return (req, res, next) => {
    if (!req.user || req.user.role !== role) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}
