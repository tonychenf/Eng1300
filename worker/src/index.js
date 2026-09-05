import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bcrypt from 'bcryptjs';
import { SignJWT, jwtVerify } from 'jose';

const app = new Hono();
app.use('*', cors());

function secretKey(env) {
  return new TextEncoder().encode(env.JWT_SECRET);
}

async function signToken(env, user) {
  return new SignJWT({ username: user.username, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secretKey(env));
}

async function requireAuth(c, next) {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.json({ error: 'missing_token' }, 401);

  try {
    const { payload } = await jwtVerify(token, secretKey(c.env));
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(Number(payload.sub))
      .first();
    if (!user || user.disabled) {
      return c.json({ error: 'account_disabled_or_missing' }, 401);
    }
    c.set('user', { id: user.id, username: user.username, role: user.role });
    await next();
  } catch {
    return c.json({ error: 'invalid_or_expired_token' }, 401);
  }
}

async function requireSuperAdmin(c, next) {
  const user = c.get('user');
  if (!user || user.role !== 'SUPER_ADMIN') {
    return c.json({ error: 'forbidden' }, 403);
  }
  await next();
}

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 12);
}

app.get('/api/health', (c) => c.json({ ok: true }));

// One-time bootstrap: creates the sole super admin account. Only works while
// the users table is empty and the caller knows the deploy-time setup token,
// since D1 has no interactive seed script the way a local Node process does.
app.post('/api/setup', async (c) => {
  const providedToken = c.req.header('X-Setup-Token') || '';
  if (!c.env.SETUP_TOKEN || providedToken !== c.env.SETUP_TOKEN) {
    return c.json({ error: 'invalid_setup_token' }, 403);
  }

  const { count } = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
  if (count > 0) {
    return c.json({ error: 'already_initialized' }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  const username = body.username || 'admin';
  const password = body.password || randomPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  await c.env.DB.prepare(
    'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
  ).bind(username, passwordHash, 'SUPER_ADMIN').run();

  return c.json({ username, password }, 201);
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, password } = body;
  if (!username || !password) {
    return c.json({ error: 'username_and_password_required' }, 400);
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(username)
    .first();
  if (!user) return c.json({ error: 'invalid_credentials' }, 401);
  if (user.disabled) return c.json({ error: 'account_disabled' }, 403);

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return c.json({ error: 'invalid_credentials' }, 401);

  await c.env.DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
    .bind(user.id)
    .run();

  const token = await signToken(c.env, user);
  return c.json({
    token,
    user: { id: user.id, username: user.username, role: user.role },
  });
});

app.get('/api/me', requireAuth, (c) => c.json({ user: c.get('user') }));

const admin = new Hono();
admin.use('*', requireAuth, requireSuperAdmin);

admin.get('/users', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id, username, role, disabled, created_at, last_login_at FROM users ORDER BY id'
  ).all();
  return c.json({ users: results });
});

admin.post('/users', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username } = body;
  if (!username) return c.json({ error: 'username_required' }, 400);

  const password = body.password || randomPassword();
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const result = await c.env.DB.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).bind(username, passwordHash, 'USER').run();

    return c.json(
      {
        user: { id: result.meta.last_row_id, username, role: 'USER' },
        initialPassword: password,
      },
      201
    );
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return c.json({ error: 'username_taken' }, 409);
    }
    throw err;
  }
});

admin.post('/users/:id/reset-password', async (c) => {
  const id = Number(c.req.param('id'));
  const user = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(id).first();
  if (!user) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const password = body.password || randomPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(passwordHash, id)
    .run();

  return c.json({ newPassword: password });
});

admin.patch('/users/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first();
  if (!user) return c.json({ error: 'not_found' }, 404);
  if (user.role === 'SUPER_ADMIN') {
    return c.json({ error: 'cannot_disable_super_admin' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const disabled = Boolean(body.disabled);
  await c.env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?')
    .bind(disabled ? 1 : 0, id)
    .run();

  return c.json({ id, disabled });
});

app.route('/api/admin', admin);

export default app;
