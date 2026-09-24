import { Hono } from 'hono';
import { cors } from 'hono/cors';
import bcrypt from 'bcryptjs';
import { signToken, requireAuth, requireSuperAdmin, isQuotaError, bestEffortWrite } from './lib/auth.js';
import { bankRouter } from './routes/admin-bank.js';
import { importRouter } from './routes/admin-import.js';
import { aiRouter } from './routes/admin-ai.js';
import { examRouter } from './routes/exam.js';
import { practiceRouter } from './routes/practice.js';
import { studyRouter } from './routes/study.js';
import { adminStatsRouter } from './routes/admin-stats.js';
import { adminSubjectsRouter } from './routes/admin-subjects.js';
import { adminGrantsRouter } from './routes/admin-grants.js';
import { adminPackRouter } from './routes/admin-pack.js';
import { subjectRouter } from './routes/subject.js';
import { accessibleSubjectFilter, accessibleCourseFilter, writeGrantWithAudit, upsertGrantStmt } from './lib/access.js';
import { pickableSql } from './lib/pickable.js';

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
    ).bind(username, fails, lockedUntil, lockedUntil || '+0 minutes').run()
      // 额度用尽时计不了失败次数，限流会暂时失效；但密码本来就是错的，
      // 该返回 401 就返回 401，不要变成一句看不懂的 503。
      .catch((err) => { if (!isQuotaError(err)) throw err; });

    // 账号被禁用与密码错误分开提示；用户名不存在与密码错误统一提示，避免账号枚举
    if (user?.disabled) return c.json({ error: 'account_disabled' }, 403);
    return c.json({ error: 'invalid_credentials' }, 401);
  }

  // 这两条都是记账，密码已经验过了，写不进去也得放人进来
  await bestEffortWrite(
    c.env.DB.prepare('DELETE FROM login_attempts WHERE username = ?').bind(username).run(),
    '清除登录失败计数'
  );
  await bestEffortWrite(
    c.env.DB.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?")
      .bind(user.id).run(),
    '更新最后登录时间'
  );

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

// 我能访问的学科。登录后的第一屏（学科选择页）就靠它。
//
// N2：学员只看到有授权的学科，管理员看到全部（accessibleSubjectFilter）。
// N1 留的接缝就是这条 SQL 加一个条件，前端与路由确实一行没改。
//
// 进度摘要通过 courses.subject_id 关联出来：attempts / wrong_items 目前还没有
// subject_id 冗余列（那是后续里程碑的事），现在走 join 是正确的，只是多一跳。
app.get('/api/me/subjects', requireAuth, async (c) => {
  const me = c.get('user');
  const acc = accessibleSubjectFilter(me);
  const { results } = await c.env.DB.prepare(
    `SELECT s.code, s.name, s.description, s.sort_order, s.content_group_kind,
            -- 学员侧的"这科有多少题能练"，判据必须与抽题同源（见 lib/pickable.js）：
            -- 按 status 数出来的是"看起来有题"，缺答案的题也算在内，
            -- 症状是学科卡片写着几百道、点进去练习报"没有可练的题"。
            (SELECT COUNT(*) FROM questions q
               JOIN courses co ON co.course_code = q.course_code
              WHERE co.subject_id = s.subject_id AND ${pickableSql('q')}) AS published_questions,
            (SELECT COUNT(*) FROM attempts a
               JOIN courses co ON co.course_code = a.course_code
              WHERE co.subject_id = s.subject_id AND a.user_id = ?1
                AND a.mode = 'EXAM' AND a.status = '已交卷') AS exam_count,
            (SELECT COUNT(*) FROM wrong_items w
               JOIN courses co ON co.course_code = w.course_code
              WHERE co.subject_id = s.subject_id AND w.user_id = ?1 AND w.corrected = 0) AS wrong_open,
            (SELECT MAX(a.started_at) FROM attempts a
               JOIN courses co ON co.course_code = a.course_code
              WHERE co.subject_id = s.subject_id AND a.user_id = ?1) AS last_activity
       FROM subjects s
      WHERE s.status = '启用' AND ${acc.sql}
      ORDER BY s.sort_order, s.subject_id`
  ).bind(me.id, ...acc.binds).all();

  return c.json({
    subjects: results.map((r) => ({
      code: r.code,
      name: r.name,
      description: r.description,
      contentGroupKind: r.content_group_kind,
      ready: r.published_questions > 0,
      publishedQuestions: r.published_questions,
      examCount: r.exam_count,
      wrongOpen: r.wrong_open,
      lastActivity: r.last_activity,
    })),
  });
});

// 课程列表（用户端选课用）
//
// N6：加了学科过滤。蓝本只有一个学科，这里就没过滤；生化的课程行一进来，
// 只授权了英语的学员在这个接口上就能看到生化——**这是 N2 那类越权**，
// 不是"多显示一行"。管理员走 accessibleCourseFilter 的 1 = 1 分支，不受影响。
app.get('/api/courses', requireAuth, async (c) => {
  const f = accessibleCourseFilter(c.get('user'), 'co');
  const { results } = await c.env.DB.prepare(
    `SELECT co.course_code, co.course_name, co.time_limit_minutes, co.total_score,
            (SELECT COUNT(*) FROM exams e WHERE e.course_code = co.course_code AND e.status = '已发布') AS published_exams,
            (SELECT COUNT(*) FROM questions q WHERE q.course_code = co.course_code
              AND ${pickableSql('q')}) AS published_questions
     FROM courses co WHERE ${f.sql} ORDER BY co.course_code`
  ).bind(...f.binds).all();
  return c.json({ courses: results });
});

// ---- 用户端：模考与练习（鉴权在各自路由文件内按前缀挂） ----
app.route('/api', subjectRouter);
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

  // 可选地在建号时一并开通学科。
  //
  // N2 之后新建学员默认没有任何学科授权，什么都打不开。分两步做当然也行，
  // 但"建完账号就能用"是绝大多数场景，而且忘了第二步不会报错——学员只会看到
  // 一句"管理员尚未为你开通任何学科"，然后来问。所以这里给一步到位的路。
  // 学科码打错就整个建号失败，不静默跳过：跳过的话账号建出来了、学科没开，
  // 正是上面那种"忘了第二步"的情形。
  const codes = Array.isArray(body.subjects) ? [...new Set(body.subjects.map(String))] : [];
  let subjectIds = [];
  if (codes.length) {
    const holes = codes.map(() => '?').join(',');
    const { results } = await c.env.DB.prepare(
      `SELECT subject_id, code FROM subjects WHERE code IN (${holes})`
    ).bind(...codes).all();
    const missing = codes.filter((x) => !results.some((r) => r.code === x));
    if (missing.length) {
      return c.json({ error: 'subject_not_found', message: `没有这些学科：${missing.join('、')}` }, 404);
    }
    subjectIds = results.map((r) => r.subject_id);
  }

  // try 只圈建号这一条：username_taken 是靠 err.message 里有 UNIQUE 判的，
  // 把授权写入也圈进来的话，那边万一报 UNIQUE 就会谎报"用户名已存在"——
  // 而账号其实已经建好了，管理员照着提示改个名字重建，就多出一个废账号。
  let newId;
  try {
    const result = await c.env.DB.prepare(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)'
    ).bind(username, passwordHash, 'USER').run();
    newId = result.meta.last_row_id;
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return c.json({ error: 'username_taken' }, 409);
    throw err;
  }

  // 授权写失败就往外抛，不吞：这次失败改变了管理员要的那个结果
  // （"建个能用的账号"），吞掉的话返回 201、学员却什么都打不开。
  for (const sid of subjectIds) {
    await writeGrantWithAudit(
      c.env.DB, c.get('user').id, newId, sid, 'GRANT', null, { status: 'ACTIVE', expires_at: null },
      upsertGrantStmt(c.env.DB, newId, sid, c.get('user').id, null, '建号时一并开通')
    );
  }

  return c.json({
    user: { id: newId, username, role: 'USER' },
    initialPassword: password,
    grantedSubjects: codes,
  }, 201);
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

// 授权路由挂在 admin 根上（它自己带 /users/:id/subjects 与 /subjects/:id/members 两组路径）。
// 必须排在 adminSubjectsRouter 之前：后者挂在 /subjects 下，
// 会先吃掉 /subjects/:id/members 与 /subjects/:id/pack。
admin.route('/', adminGrantsRouter);
admin.route('/', adminPackRouter);
admin.route('/subjects', adminSubjectsRouter);
admin.route('/bank', bankRouter);
admin.route('/bank', importRouter);   // POST /bank/import、GET /bank/import/:examId/source
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
  if (isQuotaError(err)) {
    return c.json({
      error: 'storage_quota_exceeded',
      message: '数据库今日写入额度已用尽，将在世界时零点（北京时间八点）恢复。',
    }, 503);
  }
  return c.json({ error: 'internal_error' }, 500);
});

export default app;
