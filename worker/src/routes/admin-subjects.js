// 后台学科管理。挂在 /api/admin/subjects 下，鉴权由 admin 路由组统一挂。
import { Hono } from 'hono';
import { SUBJECT_CODE_RE } from '../lib/subject.js';

export const adminSubjectsRouter = new Hono();

// 建科时定下、之后不给改的字段。
// code 会进 URL、进导出文件名、进种子文件名；content_group_kind 一改，
// 已有内容组的语义就断了（"第 3 章"突然要按年月排序）。
const IMMUTABLE = ['code', 'content_group_kind'];

adminSubjectsRouter.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT s.*,
            (SELECT COUNT(*) FROM courses co WHERE co.subject_id = s.subject_id) AS course_count,
            (SELECT COUNT(*) FROM exams e JOIN courses co ON co.course_code = e.course_code
              WHERE co.subject_id = s.subject_id) AS group_count,
            (SELECT COUNT(*) FROM questions q JOIN courses co ON co.course_code = q.course_code
              WHERE co.subject_id = s.subject_id) AS question_count,
            (SELECT COUNT(*) FROM questions q JOIN courses co ON co.course_code = q.course_code
              WHERE co.subject_id = s.subject_id AND q.status = '已发布') AS published_questions
       FROM subjects s ORDER BY s.sort_order, s.subject_id`
  ).all();
  return c.json({ subjects: results });
});

adminSubjectsRouter.post('/', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const code = String(body.code || '').trim();
  const name = String(body.name || '').trim();

  if (!SUBJECT_CODE_RE.test(code)) {
    return c.json({
      error: 'invalid_subject_code',
      message: '学科码需为 2-20 位小写字母开头，可含小写字母、数字、连字符',
    }, 400);
  }
  if (!name) return c.json({ error: 'name_required', message: '学科名称不能为空' }, 400);

  const kind = body.contentGroupKind || 'EXAM_PAPER';
  const pipeline = body.ingestPipeline || 'json-direct';

  try {
    const r = await c.env.DB.prepare(
      `INSERT INTO subjects (code, name, description, sort_order, content_group_kind, ingest_pipeline)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(code, name, body.description ?? null, Number(body.sortOrder) || 0, kind, pipeline).run();
    return c.json({ subject: { subjectId: r.meta.last_row_id, code, name } }, 201);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return c.json({ error: 'subject_code_taken', message: `学科码「${code}」已被占用` }, 409);
    }
    throw err;
  }
});

adminSubjectsRouter.patch('/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const existing = await c.env.DB.prepare('SELECT * FROM subjects WHERE subject_id = ?')
    .bind(id).first();
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => ({}));

  // 改不动的字段要明确报错，不能默默忽略——默默忽略的话调用方以为改成功了。
  const attempted = IMMUTABLE.filter((f) => {
    const key = f === 'content_group_kind' ? 'contentGroupKind' : f;
    return body[key] !== undefined && String(body[key]) !== String(existing[f]);
  });
  if (attempted.length) {
    return c.json({
      error: 'immutable_field',
      message: `${attempted.join('、')} 在建科后不可修改（它们会进 URL 与已有内容的语义）`,
    }, 400);
  }

  const sets = [];
  const binds = [];
  if (body.name !== undefined) {
    if (!String(body.name).trim()) {
      return c.json({ error: 'name_required', message: '学科名称不能为空' }, 400);
    }
    sets.push('name = ?'); binds.push(String(body.name).trim());
  }
  if (body.description !== undefined) { sets.push('description = ?'); binds.push(body.description); }
  if (body.sortOrder !== undefined) { sets.push('sort_order = ?'); binds.push(Number(body.sortOrder) || 0); }
  if (body.status !== undefined) {
    if (!['启用', '停用'].includes(body.status)) {
      return c.json({ error: 'invalid_status', message: 'status 只能是「启用」或「停用」' }, 400);
    }
    sets.push('status = ?'); binds.push(body.status);
  }
  if (!sets.length) return c.json({ error: 'nothing_to_update' }, 400);

  binds.push(id);
  await c.env.DB.prepare(`UPDATE subjects SET ${sets.join(', ')} WHERE subject_id = ?`)
    .bind(...binds).run();
  const updated = await c.env.DB.prepare('SELECT * FROM subjects WHERE subject_id = ?')
    .bind(id).first();
  return c.json({ subject: updated });
});

// 不提供删除：学科一旦有作答数据，删除会造成报告口径断裂（需求文档 §6.1）。
// 明确返回 405 并说明替代做法，比留一个 404 让人以为是路由写错了强。
adminSubjectsRouter.delete('/:id', (c) =>
  c.json({
    error: 'delete_not_supported',
    message: '学科不支持删除，请改为「停用」：停用后学员侧不可见，已有数据保留',
  }, 405));
