// JWT 签发与鉴权中间件。抽出来是为了让各个路由文件都能直接用，
// 不必把中间件挂在 /api/* 上——那样会把 /api/health、/api/auth/login 也挡住。
import { SignJWT, jwtVerify } from 'jose';

function secretKey(env) {
  return new TextEncoder().encode(env.JWT_SECRET);
}

// tv = users.token_version（CR-M2）。重置/修改密码、停用时库里加一，这里签进去的旧值就对不上了。
// 上线前签发的令牌没有 tv，按 0 算：部署那一刻不能把所有在线的人踢下线。
export async function signToken(env, user) {
  return new SignJWT({ username: user.username, role: user.role, tv: user.token_version ?? 0 })
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
  // 只有"令牌本身不成立"（验签失败、过期、格式坏）才算未登录（CR-M5）。
  // 第一版把验签、查库、next() 整段包在一个 try 里、一律回 401：查库偶发出错也成了
  // "未登录"，而前端收到 401 会清掉登录状态——数据库抖一下，在线的人全被踢回登录页。
  // 查库的错误往上抛，由 app.onError 回 500（额度用尽是 503），前端不会因此登出。
  let payload;
  try {
    ({ payload } = await jwtVerify(token, secretKey(c.env)));
  } catch {
    return c.json({ error: 'unauthorized' }, 401);
  }
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?')
    .bind(Number(payload.sub)).first();
  if (!user || user.disabled) return c.json({ error: 'unauthorized' }, 401);
  // 令牌签发之后密码被重置/修改过、或账号被停用过：旧令牌作废（CR-M2）。
  // 第一版只看"账号在不在、停没停用"，重置密码后对方手里的令牌照样能用满 8 小时。
  if ((payload.tv ?? 0) !== (user.token_version ?? 0)) return c.json({ error: 'unauthorized' }, 401);
  c.set('user', { id: user.id, username: user.username, role: user.role });
  await next();
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
