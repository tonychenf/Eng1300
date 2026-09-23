// 学科解析中间件。挂在 /api/s/:subjectCode/* 与 /api/admin/s/:subjectCode/* 上。
//
// 为什么学科码从路径取而不是从请求体取：蓝本的既有接口是 ?courseCode=xxx，
// 服务端只校验参数存在、不校验归属。多学科之后这条路径就是越权漏洞——拿 A 学科的
// token 传 B 学科的 code 就能读到别人的数据。改成路径参数 + 统一中间件，
// 是为了让"漏掉校验"变成一件做不到的事，而不是靠每个接口自觉。
//
// 见 docs/跨学科学习平台-需求文档.md §6.2.3。

/** 按学科码取学科行。找不到返回 null。 */
export async function loadSubject(db, code) {
  if (!code) return null;
  return db.prepare('SELECT * FROM subjects WHERE code = ?').bind(code).first();
}

/**
 * 解析路径里的 :subjectCode，放进 c.set('subject')。
 *
 * 学科不存在 → 404。学科的存在性不是机密：学员需要知道平台上有哪些学科才能去申请开通。
 * 学科已停用 → 403，且文案要和"没权限"分开，否则管理员停用了学科、学员却收到
 *              "请联系管理员开通"，两边都不知道发生了什么。
 *
 * N2 接缝：访问权限（user_subject_grants）在这之后再加一层 requireSubjectAccess。
 * 本中间件只负责"这个学科存不存在、能不能进"，不负责"这个人能不能进"。
 */
export async function resolveSubject(c, next) {
  const code = c.req.param('subjectCode');
  const subject = await loadSubject(c.env.DB, code);
  if (!subject) {
    return c.json({ error: 'subject_not_found', message: `没有学科「${code}」` }, 404);
  }
  if (subject.status === '停用') {
    return c.json({
      error: 'subject_suspended',
      message: `学科「${subject.name}」已停用`,
    }, 403);
  }
  c.set('subject', subject);
  await next();
}

/** 学科码格式：进 URL、进导出文件名、进种子文件名，所以限制得严一点。 */
export const SUBJECT_CODE_RE = /^[a-z][a-z0-9-]{1,19}$/;
