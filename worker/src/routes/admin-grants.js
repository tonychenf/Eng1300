// 后台学科授权。挂在 /api/admin 下，鉴权与角色校验由 admin 路由组统一挂。
//
// 两个视角都要，因为两种操作场景都真实存在（需求文档 §6.2.4）：
//   单人视角   新学员入学，一次给他开好几个学科
//   单学科视角 新学科开课，一次给一批学员开通
import { Hono } from 'hono';

export const adminGrantsRouter = new Hono();

// 授权变更与审计用 batch 一起落。
//
// 不用"审计写失败就吞掉"的记账式处理：权限审计悄悄少几条，
// 事后想查"谁把这个人的学科关掉的"就查不出来了，而且没人会知道它丢过。
// D1 的 batch 是一个事务，两条要么都成要么都不成。
function writeWithAudit(db, actorId, targetUserId, subjectId, action, before, after, stmt) {
  return db.batch([
    stmt,
    db.prepare(
      `INSERT INTO subject_grant_audit
         (actor_id, target_user_id, subject_id, action, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(actorId, targetUserId, subjectId, action,
           before ? JSON.stringify(before) : null,
           after ? JSON.stringify(after) : null),
  ]);
}

async function loadStudent(db, id) {
  return db.prepare("SELECT id, username, role, disabled FROM users WHERE id = ?").bind(id).first();
}

// ---------------- 单人视角 ----------------

// 列出全部学科，并标出这个人的授权状态。返回全部而不只是已授权的，
// 因为界面要的是一张可勾选的清单，不是一份已开通名单。
adminGrantsRouter.get('/users/:id/subjects', async (c) => {
  const id = Number(c.req.param('id'));
  const user = await loadStudent(c.env.DB, id);
  if (!user) return c.json({ error: 'not_found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT s.subject_id, s.code, s.name, s.status AS subject_status,
            g.status AS grant_status, g.expires_at, g.granted_at, g.note,
            (SELECT username FROM users u2 WHERE u2.id = g.granted_by) AS granted_by_name
       FROM subjects s
       LEFT JOIN user_subject_grants g ON g.subject_id = s.subject_id AND g.user_id = ?
      ORDER BY s.sort_order, s.subject_id`
  ).bind(id).all();

  return c.json({
    user: { id: user.id, username: user.username, role: user.role, disabled: !!user.disabled },
    // 管理员本来就通吃所有学科，给他发授权没有意义，界面据此给出说明而不是一堆勾选框
    adminBypass: user.role === 'SUPER_ADMIN',
    subjects: results,
  });
});

// 整体设置某人的授权。body.subjects 是**完整集合**：没列进来的一律撤销。
// 用完整集合而不是增量，是因为界面就是一组勾选框，提交的本来就是勾选后的全集；
// 增量语义下"取消勾选"要单独发一次删除，容易漏。
adminGrantsRouter.put('/users/:id/subjects', async (c) => {
  const me = c.get('user');
  const id = Number(c.req.param('id'));
  const user = await loadStudent(c.env.DB, id);
  if (!user) return c.json({ error: 'not_found' }, 404);
  if (user.role === 'SUPER_ADMIN') {
    return c.json({
      error: 'admin_needs_no_grant',
      message: '超级管理员本就可以访问所有学科，不需要也不能单独授权',
    }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const wanted = Array.isArray(body.subjects) ? body.subjects : null;
  if (!wanted) return c.json({ error: 'invalid_request', message: 'subjects 必须是数组' }, 400);

  const { results: allSubjects } = await c.env.DB.prepare(
    'SELECT subject_id, code FROM subjects'
  ).all();
  const byCode = new Map(allSubjects.map((s) => [s.code, s.subject_id]));

  const unknown = wanted.map((w) => w.code).filter((code) => !byCode.has(code));
  if (unknown.length) {
    return c.json({ error: 'subject_not_found', message: `没有这些学科：${unknown.join('、')}` }, 404);
  }

  const { results: existing } = await c.env.DB.prepare(
    'SELECT subject_id, status, expires_at FROM user_subject_grants WHERE user_id = ?'
  ).bind(id).all();
  const before = new Map(existing.map((g) => [g.subject_id, g]));

  let granted = 0, revoked = 0, updated = 0;
  for (const w of wanted) {
    const sid = byCode.get(w.code);
    const exp = w.expiresAt || null;
    const prev = before.get(sid);
    if (prev && prev.status === 'ACTIVE' && (prev.expires_at || null) === exp) continue;
    await writeWithAudit(
      c.env.DB, me.id, id, sid, prev ? 'UPDATE' : 'GRANT',
      prev || null, { status: 'ACTIVE', expires_at: exp },
      c.env.DB.prepare(
        `INSERT INTO user_subject_grants (user_id, subject_id, status, granted_by, expires_at, note)
         VALUES (?, ?, 'ACTIVE', ?, ?, ?)
         ON CONFLICT(user_id, subject_id) DO UPDATE SET
           status = 'ACTIVE', granted_by = excluded.granted_by,
           granted_at = datetime('now'), expires_at = excluded.expires_at`
      ).bind(id, sid, me.id, exp, w.note || null)
    );
    prev ? updated++ : granted++;
  }

  const keep = new Set(wanted.map((w) => byCode.get(w.code)));
  for (const g of existing) {
    if (keep.has(g.subject_id)) continue;
    await writeWithAudit(
      c.env.DB, me.id, id, g.subject_id, 'REVOKE', g, null,
      c.env.DB.prepare('DELETE FROM user_subject_grants WHERE user_id = ? AND subject_id = ?')
        .bind(id, g.subject_id)
    );
    revoked++;
  }

  return c.json({ ok: true, granted, updated, revoked });
});

// ---------------- 单学科视角 ----------------

adminGrantsRouter.get('/subjects/:id/members', async (c) => {
  const sid = Number(c.req.param('id'));
  const subject = await c.env.DB.prepare('SELECT * FROM subjects WHERE subject_id = ?')
    .bind(sid).first();
  if (!subject) return c.json({ error: 'not_found' }, 404);

  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.disabled, g.status, g.expires_at, g.granted_at, g.note
       FROM user_subject_grants g JOIN users u ON u.id = g.user_id
      WHERE g.subject_id = ? ORDER BY u.username`
  ).bind(sid).all();

  const total = await c.env.DB.prepare(
    "SELECT COUNT(*) AS n FROM users WHERE role = 'USER'"
  ).first();

  return c.json({
    subject: { subjectId: subject.subject_id, code: subject.code, name: subject.name },
    members: results,
    studentTotal: total.n,
  });
});

// 批量按用户名开通。
//
// 找不到的用户名不整批失败：一次粘二十个名字进来，因为其中一个打错就全不生效，
// 操作的人得自己一个个对出来是哪个错了。这里照常开通其余的，把没找到的列出来。
adminGrantsRouter.post('/subjects/:id/members', async (c) => {
  const me = c.get('user');
  const sid = Number(c.req.param('id'));
  const subject = await c.env.DB.prepare('SELECT * FROM subjects WHERE subject_id = ?')
    .bind(sid).first();
  if (!subject) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const names = Array.isArray(body.usernames)
    ? [...new Set(body.usernames.map((n) => String(n).trim()).filter(Boolean))]
    : null;
  if (!names || !names.length) {
    return c.json({ error: 'invalid_request', message: 'usernames 必须是非空数组' }, 400);
  }
  const expiresAt = body.expiresAt || null;

  const holes = names.map(() => '?').join(',');
  const { results: found } = await c.env.DB.prepare(
    `SELECT id, username, role FROM users WHERE username IN (${holes})`
  ).bind(...names).all();

  const foundNames = new Set(found.map((u) => u.username));
  const notFound = names.filter((n) => !foundNames.has(n));
  const admins = found.filter((u) => u.role === 'SUPER_ADMIN').map((u) => u.username);
  const students = found.filter((u) => u.role === 'USER');

  let granted = 0;
  for (const u of students) {
    const prev = await c.env.DB.prepare(
      'SELECT status, expires_at FROM user_subject_grants WHERE user_id = ? AND subject_id = ?'
    ).bind(u.id, sid).first();
    await writeWithAudit(
      c.env.DB, me.id, u.id, sid, prev ? 'UPDATE' : 'GRANT',
      prev || null, { status: 'ACTIVE', expires_at: expiresAt },
      c.env.DB.prepare(
        `INSERT INTO user_subject_grants (user_id, subject_id, status, granted_by, expires_at, note)
         VALUES (?, ?, 'ACTIVE', ?, ?, ?)
         ON CONFLICT(user_id, subject_id) DO UPDATE SET
           status = 'ACTIVE', granted_by = excluded.granted_by,
           granted_at = datetime('now'), expires_at = excluded.expires_at`
      ).bind(u.id, sid, me.id, expiresAt, body.note || null)
    );
    granted++;
  }

  return c.json({
    granted,
    notFound,
    // 管理员通吃，给他发授权没意义，但也不该当成错误把整批挡下来
    skippedAdmins: admins,
  });
});

adminGrantsRouter.delete('/subjects/:id/members/:userId', async (c) => {
  const me = c.get('user');
  const sid = Number(c.req.param('id'));
  const uid = Number(c.req.param('userId'));
  const prev = await c.env.DB.prepare(
    'SELECT status, expires_at FROM user_subject_grants WHERE user_id = ? AND subject_id = ?'
  ).bind(uid, sid).first();
  if (!prev) return c.json({ error: 'not_found', message: '这个人本来就没有该学科的授权' }, 404);

  await writeWithAudit(
    c.env.DB, me.id, uid, sid, 'REVOKE', prev, null,
    c.env.DB.prepare('DELETE FROM user_subject_grants WHERE user_id = ? AND subject_id = ?')
      .bind(uid, sid)
  );
  return c.json({ ok: true });
});

// ---------------- 审计 ----------------

adminGrantsRouter.get('/grants/audit', async (c) => {
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const { results } = await c.env.DB.prepare(
    `SELECT a.id, a.action, a.before_json, a.after_json, a.created_at,
            actor.username AS actor, target.username AS target, s.code AS subject_code, s.name AS subject_name
       FROM subject_grant_audit a
       LEFT JOIN users actor ON actor.id = a.actor_id
       LEFT JOIN users target ON target.id = a.target_user_id
       LEFT JOIN subjects s ON s.subject_id = a.subject_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT ?`
  ).bind(limit).all();
  return c.json({ entries: results });
});
