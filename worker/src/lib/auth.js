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

// D1 免费版每天有写入行数上限，用尽后所有写操作都失败。
export function isQuotaError(err) {
  const msg = String(err?.message || '');
  return msg.includes('D1_ERROR') && /daily row (write|read) limit/i.test(msg);
}

// 记账性质的写入：失败了也不该影响调用方的结果。
//
// 起因：登录成功后要清失败计数、写最后登录时间，这两条写入一旦因额度用尽
// 报错，整个登录就返回 503——密码明明是对的，人却进不来，站点等于全站不可用。
// 额度用尽时站点应该退化成"写不进新数据"，而不是"登录不了"。
// 只吞额度这一类错误，别的照常抛出去，免得把真 bug 藏起来。
export async function bestEffortWrite(promise, label) {
  try {
    await promise;
  } catch (err) {
    if (!isQuotaError(err)) throw err;
    console.warn(`写入额度已用尽，跳过记账写入：${label}`);
  }
}
