import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bcrypt from 'bcryptjs';
import { signToken, requireAuth, requireSuperAdmin } from './lib/auth.js';
import { bankRouter } from './routes/admin-bank.js';
import { aiRouter } from './routes/admin-ai.js';
import { examRouter } from './routes/exam.js';
import { practiceRouter } from './routes/practice.js';
import { studyRouter } from './routes/study.js';
import { adminStatsRouter } from './routes/admin-stats.js';

const app = new Hono();
app.use('/api/*', cors());

const MAX_LOGIN_FAILURES = 5;
const LOCK_MINUTES = 10;

function randomPassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 12);
}

app.get('/api/health', (c) => c.json({ ok: true }));

// 一次性初始化超级管理员
app.post('/api/setup', async (c) => {
  const provided = c.req.header('X-Setup-Token') || '';
  if (!c.env.SETUP_TOKEN || provided !== c.env.SETUP_TOKEN) {
    return c.json({ error: 'invalid_setup_token' }, 403);
  }
  const { count } = await c.env.DB.prepare('SELECT COUNT(*) as count FROM users').first();
  if (count > 0) return c.json({ error: 'already_initialized' }, 409);

  const body = await c.req.json().catch(() => ({}));
  const username = body.username || 'admin';
  const password = body.password || randomPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  await c.env.DB.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .bind(username, passwordHash, 'SUPER_ADMIN').run();
  return c.json({ username, password }, 201);
});

app.post('/api/auth/login', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const { username, password } = body;
  if (!username || !password) return c.json({ error: 'invalid_request' }, 400);

  // 限流检查：锁定期内直接拒绝，不消耗密码校验
  const attempt = await c.env.DB.prepare('SELECT * FROM login_attempts WHERE username = ?')
    .bind(username).first();
  if (attempt?.locked_until) {
    const locked = await c.env.DB.prepare(
      "SELECT datetime('now') < ? AS still_locked"
    ).bind(attempt.locked_until).first();
    if (locked?.still_locked) {
      return c.json({
        error: 'too_many_attempts',
        message: `登录失败次数过多，请在 ${LOCK_MINUTES} 分钟后重试`,
      }, 429);
    }
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?')
    .bind(username).first();
  const ok = user && !user.disabled && (await bcrypt.compare(password, user.password_hash));

  if (!ok) {
    const fails = (attempt?.fail_count || 0) + 1;
    const lockedUntil = fails >= MAX_LOGIN_FAILURES ? `+${LOCK_MINUTES} minutes` : null;
    await c.env.DB.prepare(
      `INSERT INTO login_attempts (username, fail_count, locked_until, last_failed_at)
       VALUES (?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now', ?) END, datetime('now'))
       ON CONFLICT(username) DO UPDATE SET
         fail_count = excluded.fail_count,
         locked_until = excluded.locked_until,
         last_failed_at = excluded.last_failed_at`
    ).bind(username, fails, lockedUntil, lockedUntil || '+0 minutes').run();

    // 账号被禁用与密码错误分开提示；用户名不存在与密码错误统一提示，避免账号枚举
    if (user?.disabled) return c.json({ error: 'account_disabled' }, 403);
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  await c.env.DB.prepare('DELETE FROM login_attempts WHERE username = ?').bind(username).run();
  await c.env.DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
    .bind(user.id).run();

  const token = await signToken(c.env, user);
  return c.json({ token, user: { id: user.id, username: user.username, role: user.role } });
});

app.get('/api/me', requireAuth, (c) => c.json({ user: c.get('user') }));

// 修改自己的密码（PRD §5.1.3）
app.post('/api/me/password', requireAuth, async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const { currentPassword, newPassword } = body;
  if (!currentPassword || !newPassword) return c.json({ error: 'invalid_request' }, 400);
  if (newPassword.length < 8 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return c.json({ error: 'weak_password', message: '新密码至少8位，且需同时包含字母和数字' }, 400);
  }
  if (newPassword === currentPassword) {
    return c.json({ error: 'same_password', message: '新密码不能与当前密码相同' }, 400);
  }

  const user = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(me.id).first();
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    return c.json({ error: 'invalid_credentials', message: '当前密码不正确' }, 401);
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?').bind(hash, me.id).run();
  return c.json({ ok: true });
});

// 课程列表（用户端选课用）
app.get('/api/courses', requireAuth, async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT co.course_code, co.course_name, co.time_limit_minutes, co.total_score,
            (SELECT COUNT(*) FROM exams e WHERE e.course_code = co.course_code AND e.status = '已发布') AS published_exams,
            (SELECT COUNT(*) FROM questions q WHERE q.course_code = co.course_code AND q.status = '已发布') AS published_questions
     FROM courses co ORDER BY co.course_code`
  ).all();
  return c.json({ courses: results });
});

// ---- 用户端：模考与练习（鉴权在各自路由文件内按前缀挂） ----
app.route('/api', examRouter);
app.route('/api', practiceRouter);
app.route('/api', studyRouter);

// ---- 后台 ----
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
  if (!/^[A-Za-z0-9_]{3,20}$/.test(username)) {
    return c.json({ error: 'invalid_username', message: '用户名需为3-20位字母、数字或下划线' }, 400);
  }
  const password = body.password || randomPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  try {
    const result = await c.env.DB.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).bind(username, passwordHash, 'USER').run();
    return c.json({
      user: { id: result.meta.last_row_id, username, role: 'USER' },
      initialPassword: password,
    }, 201);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return c.json({ error: 'username_taken' }, 409);
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
    .bind(passwordHash, id).run();
  await c.env.DB.prepare('DELETE FROM login_attempts WHERE username = (SELECT username FROM users WHERE id = ?)')
    .bind(id).run();
  return c.json({ newPassword: password });
});

admin.patch('/users/:id/status', async (c) => {
  const id = Number(c.req.param('id'));
  const user = await c.env.DB.prepare('SELECT id, role FROM users WHERE id = ?').bind(id).first();
  if (!user) return c.json({ error: 'not_found' }, 404);
  if (user.role === 'SUPER_ADMIN') return c.json({ error: 'cannot_disable_super_admin' }, 400);
  const body = await c.req.json().catch(() => ({}));
  const disabled = Boolean(body.disabled);
  await c.env.DB.prepare('UPDATE users SET disabled = ? WHERE id = ?')
    .bind(disabled ? 1 : 0, id).run();
  return c.json({ id, disabled });
});

// 系统参数
admin.get('/settings', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM system_settings ORDER BY key').all();
  return c.json({ settings: results });
});

admin.put('/settings/:key', async (c) => {
  const key = c.req.param('key');
  const body = await c.req.json().catch(() => ({}));
  if (body.value === undefined) return c.json({ error: 'value_required' }, 400);
  const res = await c.env.DB.prepare('UPDATE system_settings SET value = ? WHERE key = ?')
    .bind(String(body.value), key).run();
  if (!res.meta.changes) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, key, value: String(body.value) });
});

admin.route('/bank', bankRouter);
admin.route('/ai', aiRouter);
admin.route('/stats', adminStatsRouter);
app.route('/api/admin', admin);

// 静态资源由 wrangler [assets] 处理，Worker 只会收到 /api/*，
// 未匹配的一律按接口返回 JSON，避免前端拿到一段 HTML 去 JSON.parse
app.notFound((c) => c.json({ error: 'not_found' }, 404));

app.onError((err, c) => {
  console.error(err);
  // D1 免费版每天有写入行数上限，用尽后所有写操作都会失败（登录也要写最后登录时间）。
  // 单独认出来，前端才能显示一句人能看懂的话，而不是"服务器内部错误"。
  const msg = String(err?.message || '');
  if (msg.includes('D1_ERROR') && /daily row (write|read) limit/i.test(msg)) {
    return c.json({
      error: 'storage_quota_exceeded',
      message: '数据库今日写入额度已用尽，将在世界时零点（北京时间八点）恢复。',
    }, 503);
  }
  return c.json({ error: 'internal_error' }, 500);
});

export default app;
