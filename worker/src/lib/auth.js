// JWT 签发与鉴权中间件。抽出来是为了让各个路由文件都能直接用，
// 不必把中间件挂在 /api/* 上——那样会把 /api/health、/api/auth/login 也挡住。
import { SignJWT, jwtVerify } from 'jose';

function secretKey(env) {
  return new TextEncoder().encode(env.JWT_SECRET);
}

export async function signToken(env, user) {
  return new SignJWT({ username: user.username, role: user.role })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(String(user.id))
    .setIssuedAt()
    .setExpirationTime('8h')
    .sign(secretKey(env));
}

export async function requireAuth(c, next) {
  const header = c.req.header('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return c.json({ error: 'unauthorized' }, 401);
  try {
    const { payload } = await jwtVerify(token, secretKey(c.env));
    const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
      .bind(Number(payload.sub)).first();
    if (!user || user.disabled) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', { id: user.id, username: user.username, role: user.role });
    await next();
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
}

export async function requireSuperAdmin(c, next) {
  const user = c.get('user');
  if (!user || user.role !== 'SUPER_ADMIN') return c.json({ error: 'forbidden' }, 403);
  await next();
}
