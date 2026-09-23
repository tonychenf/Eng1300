// 学科访问控制。对应 docs/跨学科学习平台-需求文档.md §6.2。
//
// 两级角色：SUPER_ADMIN 通吃所有学科，USER 按 user_subject_grants 授权。
//
// ── 不做缓存（与文档 §6.2.2 的差异） ──────────────────────────────
// 文档说可以在 Worker 实例内存里缓存授权 ≤60 秒，并要求撤销 ≤60 秒生效。
// 这里不缓存，每次查库。理由：这是一条命中主键索引的单行查询，省下来的那点延迟
// 远不值得引入"缓存里还是旧授权"这种静默错误——管理员点了撤销、界面说成功了，
// 学员却还能继续做题，而且没有任何报错。不缓存的话撤销是立即生效，比文档的
// 承诺更强。真到了需要缓存的时候再加，那时要连过期一起测。
//
// ── 三类接口，三种处理 ────────────────────────────────────────────
// A 收 courseCode 的（组卷、开练习、错题本、能力评估）→ requireCourseAccess
// B 路径带 attempt id 的（取卷、答题、交卷、报告）    → requireAttemptAccess
// C 跨学科聚合的（历史记录、进行中的练习、错题本筛选项）→ accessibleCourseFilter
//
// C 类不能用 403：这些接口本身是合法的，问题在于结果集里不能出现无授权学科的行。
// 只做 403 的话这三个接口会继续漏数据——学科被撤销了，历史记录里那几次模考还在。

export function isAdmin(user) {
  return user?.role === 'SUPER_ADMIN';
}

// 一条授权有效的条件。两处用到，抽出来免得改一处漏一处。
const GRANT_VALID = "g.status = 'ACTIVE' AND (g.expires_at IS NULL OR g.expires_at > datetime('now'))";

/**
 * 查一个人对一个学科的授权状态。
 * 返回 { ok: true } 或 { ok: false, code, message }。
 * 分开报"没授权""被停授""已过期"：合并成一句的话，管理员排查时看不出是哪种。
 */
export async function checkGrant(db, user, subject) {
  if (isAdmin(user)) return { ok: true };

  const g = await db.prepare(
    'SELECT status, expires_at FROM user_subject_grants WHERE user_id = ? AND subject_id = ?'
  ).bind(user.id, subject.subject_id).first();

  if (!g) {
    return { ok: false, code: 'subject_forbidden',
             message: `你没有「${subject.name}」的访问权限，请联系管理员开通` };
  }
  if (g.status === 'SUSPENDED') {
    return { ok: false, code: 'grant_suspended',
             message: `你对「${subject.name}」的访问已被暂停，请联系管理员` };
  }
  if (g.expires_at) {
    const row = await db.prepare("SELECT datetime('now') >= ? AS expired").bind(g.expires_at).first();
    if (row?.expired) {
      return { ok: false, code: 'grant_expired',
               message: `你对「${subject.name}」的访问已于 ${g.expires_at} 到期，请联系管理员` };
    }
  }
  return { ok: true };
}

async function subjectOfCourse(db, courseCode) {
  return db.prepare(
    `SELECT s.* FROM subjects s JOIN courses co ON co.subject_id = s.subject_id
      WHERE co.course_code = ?`
  ).bind(courseCode).first();
}

async function subjectOfAttempt(db, attemptId, userId) {
  return db.prepare(
    `SELECT s.* FROM subjects s
       JOIN courses co ON co.subject_id = s.subject_id
       JOIN attempts a ON a.course_code = co.course_code
      WHERE a.attempt_id = ? AND a.user_id = ?`
  ).bind(attemptId, userId).first();
}

// 请求里的 courseCode 可能在 query 也可能在 body。
// body 读两次是安全的：Hono 4 的 HonoRequest 有 bodyCache，json() 走的是缓存过的 text，
// 中间件读过之后 handler 再读拿的是同一份。
async function courseCodeOf(c) {
  const q = c.req.query('courseCode');
  if (q) return q;
  const m = c.req.method;
  if (m === 'POST' || m === 'PUT' || m === 'PATCH') {
    const body = await c.req.json().catch(() => null);
    if (body && typeof body.courseCode === 'string') return body.courseCode;
  }
  return null;
}

/**
 * A 类：按 courseCode 判。用于组卷、开练习、按课程查错题本与评估。
 *
 * 学科停用时也拦——停用的语义就是"学员侧不可见、不可进入"（§6.1）。
 * 拿不到 courseCode 的请求放行：那是参数缺失，由 handler 自己报 400，
 * 在这里拦会把"少传参数"说成"没权限"，把人引到错误的方向。
 */
export async function requireCourseAccess(c, next) {
  const user = c.get('user');
  const courseCode = await courseCodeOf(c);
  if (!courseCode) return next();

  const subject = await subjectOfCourse(c.env.DB, courseCode);
  if (!subject) {
    return c.json({ error: 'course_not_found', message: `没有课程「${courseCode}」` }, 404);
  }
  if (subject.status === '停用' && !isAdmin(user)) {
    return c.json({ error: 'subject_suspended', message: `学科「${subject.name}」已停用` }, 403);
  }
  const r = await checkGrant(c.env.DB, user, subject);
  if (!r.ok) return c.json({ error: r.code, message: r.message }, 403);

  c.set('subject', subject);
  await next();
}

// 从路径里取 attempt id。
//
// 不能用 c.req.param('id')：中间件是用 use('/attempts/*') 这类模式挂的，
// 它自己的模式里没有 :id，Hono 只把匹配到该模式的 handler 的参数放进 param()，
// 所以在中间件里取到的永远是 undefined。
//
// 这个坑不报错：取不到就 return next()，中间件静默失效，403 该出的地方出 200，
// 从外面看一切正常。第一版就是这么写的，是 n2-grants.sh 那条
// "撤销立即生效，取卷被拒" 把它抓出来的。
const ATTEMPT_IN_PATH = /\/(?:attempts|practice)\/([^/?]+)/;

function attemptIdFrom(c) {
  const fromParam = c.req.param('id');
  if (fromParam) return fromParam;
  const m = ATTEMPT_IN_PATH.exec(c.req.path);
  return m ? m[1] : null;
}

/**
 * B 类：按路径里的 attempt id 判。用于取卷、答题、交卷、报告。
 *
 * 与 A 类的一处差别：**学科停用不拦这里**。会话已经开始了，停用只该拦新会话——
 * 否则管理员一停用，正在考试的人就卡死在卷面上，交不了卷也看不了报告
 * （需求文档 §6.1 的验收条件 P4）。授权被撤销仍然拦：那是管理员针对这个人的
 * 明确动作，和"整个学科下线"不是一回事。
 *
 * 找不到 attempt 就放行。这里放行是安全的，三种情况都兜得住：
 *   路径段不是 attempt id（如 /practice/start、/practice/active）——真正的校验由
 *     requireCourseAccess 或 handler 里的行过滤完成；
 *   attempt 不存在——handler 报 404；
 *   attempt 是别人的——exam.js 的 loadAttempt 有 user_id 比对，报 403。
 */
export async function requireAttemptAccess(c, next) {
  const user = c.get('user');
  const attemptId = attemptIdFrom(c);
  if (!attemptId) return next();

  const subject = await subjectOfAttempt(c.env.DB, attemptId, user.id);
  if (!subject) return next();

  const r = await checkGrant(c.env.DB, user, subject);
  if (!r.ok) return c.json({ error: r.code, message: r.message }, 403);

  c.set('subject', subject);
  await next();
}

/**
 * C 类：跨学科聚合接口的行过滤。
 *
 * 返回 { sql, binds }，拼进 WHERE。alias 是那张表在 SQL 里的别名，
 * 它必须有 course_code 列（attempts、wrong_items 都有）。
 *
 * 管理员返回恒真条件而不是跳过拼接，这样调用方的 SQL 形状不随角色变化——
 * 两套 SQL 分支是"其中一套长期没人走、悄悄写错了也没人知道"的温床。
 */
export function accessibleCourseFilter(user, alias) {
  if (isAdmin(user)) return { sql: '1 = 1', binds: [] };
  return {
    sql: `${alias}.course_code IN (
            SELECT co.course_code FROM courses co
              JOIN user_subject_grants g ON g.subject_id = co.subject_id
              JOIN subjects s ON s.subject_id = co.subject_id
             WHERE g.user_id = ? AND s.status = '启用' AND ${GRANT_VALID})`,
    binds: [user.id],
  };
}

/** /api/me/subjects 用：学员只看到有授权的，管理员看到全部。 */
export function accessibleSubjectFilter(user) {
  if (isAdmin(user)) return { sql: '1 = 1', binds: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM user_subject_grants g
                   WHERE g.subject_id = s.subject_id AND g.user_id = ? AND ${GRANT_VALID})`,
    binds: [user.id],
  };
}

// ── 授权写入 ──────────────────────────────────────────────────────
//
// 授权变更与审计用 batch 一起落。不用"审计写失败就吞掉"的记账式处理：
// 权限审计悄悄少几条，事后想查"谁把这个人的学科关掉的"就查不出来，
// 而且没人会知道它丢过。D1 的 batch 是一个事务，两条要么都成要么都不成。
//
// 放在这里而不是某个路由文件里：建账号和管授权两处都要写授权，
// 各写一份的话审计格式会慢慢长歪，而这种歪法不会报错。
export function writeGrantWithAudit(db, actorId, targetUserId, subjectId, action, before, after, stmt) {
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

export function upsertGrantStmt(db, userId, subjectId, actorId, expiresAt, note) {
  return db.prepare(
    `INSERT INTO user_subject_grants (user_id, subject_id, status, granted_by, expires_at, note)
     VALUES (?, ?, 'ACTIVE', ?, ?, ?)
     ON CONFLICT(user_id, subject_id) DO UPDATE SET
       status = 'ACTIVE', granted_by = excluded.granted_by,
       granted_at = datetime('now'), expires_at = excluded.expires_at`
  ).bind(userId, subjectId, actorId, expiresAt ?? null, note ?? null);
}
