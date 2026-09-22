import { Hono } from 'hono';

export const bankRouter = new Hono();

// 题库总览：按课程统计（PRD §5.3.3）
bankRouter.get('/stats', async (c) => {
  const { results: byCourse } = await c.env.DB.prepare(
    `SELECT e.course_code, co.course_name,
            COUNT(DISTINCT e.exam_id) AS exam_count,
            SUM(CASE WHEN e.status = '已发布' THEN 1 ELSE 0 END) AS published_exams
     FROM exams e JOIN courses co ON co.course_code = e.course_code
     GROUP BY e.course_code, co.course_name ORDER BY e.course_code`
  ).all();

  const { results: byType } = await c.env.DB.prepare(
    `SELECT course_code, section_type,
            COUNT(*) AS total,
            SUM(CASE WHEN status = '已发布' THEN 1 ELSE 0 END) AS published
     FROM questions GROUP BY course_code, section_type ORDER BY course_code, section_type`
  ).all();

  const { results: byTag } = await c.env.DB.prepare(
    `SELECT k.name, COUNT(*) AS total,
            SUM(CASE WHEN q.status = '已发布' THEN 1 ELSE 0 END) AS published
     FROM question_knowledge_points x
     JOIN knowledge_points k ON k.tag_id = x.tag_id
     JOIN questions q ON q.question_id = x.question_id
     GROUP BY k.name ORDER BY total DESC`
  ).all();

  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM exam_parsing_notes WHERE resolved = 0`
  ).first();

  return c.json({ byCourse, byType, byTag, unresolvedNotes: pending?.n || 0 });
});

// 试卷列表，支持按课程/状态筛选
bankRouter.get('/exams', async (c) => {
  const courseCode = c.req.query('courseCode');
  const status = c.req.query('status');
  const conds = [];
  const binds = [];
  if (courseCode) { conds.push('e.course_code = ?'); binds.push(courseCode); }
  if (status) { conds.push('e.status = ?'); binds.push(status); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const { results } = await c.env.DB.prepare(
    `SELECT e.exam_id, e.course_code, co.course_name, e.title, e.year, e.month,
            e.status, e.created_at, e.published_at,
            (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.exam_id) AS question_count,
            (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.exam_id AND q.reviewed = 1) AS reviewed_count,
            (SELECT COUNT(*) FROM exam_parsing_notes p WHERE p.exam_id = e.exam_id AND p.resolved = 0) AS open_notes
     FROM exams e JOIN courses co ON co.course_code = e.course_code
     ${where}
     ORDER BY e.course_code, e.year DESC, e.month DESC`
  ).bind(...binds).all();

  return c.json({ exams: results });
});

// 整卷详情：全部 section、题目、考点标签、存疑记录
bankRouter.get('/exams/:examId', async (c) => {
  const examId = c.req.param('examId');
  const exam = await c.env.DB.prepare(
    `SELECT e.*, co.course_name FROM exams e JOIN courses co ON co.course_code = e.course_code
     WHERE e.exam_id = ?`
  ).bind(examId).first();
  if (!exam) return c.json({ error: 'not_found' }, 404);

  const { results: sections } = await c.env.DB.prepare(
    `SELECT * FROM sections WHERE exam_id = ? ORDER BY ord`
  ).bind(examId).all();

  const { results: questions } = await c.env.DB.prepare(
    `SELECT q.*, (
       SELECT group_concat(k.name, '||') FROM question_knowledge_points x
       JOIN knowledge_points k ON k.tag_id = x.tag_id WHERE x.question_id = q.question_id
     ) AS tag_names
     FROM questions q WHERE q.exam_id = ? ORDER BY q.ord`
  ).bind(examId).all();

  const { results: notes } = await c.env.DB.prepare(
    `SELECT * FROM exam_parsing_notes WHERE exam_id = ? ORDER BY id`
  ).bind(examId).all();

  const shaped = sections.map((s) => ({
    ...s,
    questions: questions
      .filter((q) => q.section_id === s.section_id)
      .map((q) => ({
        ...q,
        options: q.options ? JSON.parse(q.options) : null,
        knowledgePoints: q.tag_names ? q.tag_names.split('||') : [],
      })),
  }));

  return c.json({ exam, sections: shaped, parsingNotes: notes });
});

// 校对：修改单题
bankRouter.patch('/questions/:questionId', async (c) => {
  const questionId = c.req.param('questionId');
  const body = await c.req.json().catch(() => ({}));
  const existing = await c.env.DB.prepare('SELECT * FROM questions WHERE question_id = ?')
    .bind(questionId).first();
  if (!existing) return c.json({ error: 'not_found' }, 404);

  const fields = [];
  const binds = [];
  for (const [key, col] of [
    ['stem', 'stem'],
    ['answer', 'answer'],
    ['answerExplanation', 'answer_explanation'],
    ['difficultyTag', 'difficulty_tag'],
  ]) {
    if (key in body) { fields.push(`${col} = ?`); binds.push(body[key]); }
  }
  if ('options' in body) {
    fields.push('options = ?');
    binds.push(body.options ? JSON.stringify(body.options) : null);
  }
  if ('status' in body) {
    if (!['草稿', '已发布', '存疑'].includes(body.status)) {
      return c.json({ error: 'invalid_status' }, 400);
    }
    fields.push('status = ?'); binds.push(body.status);
  }
  if ('reviewed' in body) { fields.push('reviewed = ?'); binds.push(body.reviewed ? 1 : 0); }

  if (fields.length) {
    binds.push(questionId);
    await c.env.DB.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE question_id = ?`)
      .bind(...binds).run();
  }

  // 考点标签整体替换
  if (Array.isArray(body.knowledgePoints)) {
    await c.env.DB.prepare('DELETE FROM question_knowledge_points WHERE question_id = ?')
      .bind(questionId).run();
    for (const name of body.knowledgePoints) {
      let tag = await c.env.DB.prepare('SELECT tag_id FROM knowledge_points WHERE name = ?')
        .bind(name).first();
      if (!tag) {
        const tagId = `kp-${crypto.randomUUID().slice(0, 8)}`;
        await c.env.DB.prepare('INSERT INTO knowledge_points (tag_id, name) VALUES (?, ?)')
          .bind(tagId, name).run();
        tag = { tag_id: tagId };
      }
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO question_knowledge_points (question_id, tag_id) VALUES (?, ?)'
      ).bind(questionId, tag.tag_id).run();
    }
  }

  return c.json({ ok: true });
});

// 存疑记录：标记已处理 / 撤销
bankRouter.patch('/notes/:noteId', async (c) => {
  const noteId = Number(c.req.param('noteId'));
  const body = await c.req.json().catch(() => ({}));
  const resolved = body.resolved ? 1 : 0;
  const res = await c.env.DB.prepare(
    `UPDATE exam_parsing_notes SET resolved = ?, resolved_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
     WHERE id = ?`
  ).bind(resolved, resolved, noteId).run();
  if (!res.meta.changes) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true, resolved: Boolean(resolved) });
});

// 发布整卷：所有存疑记录处理完才允许（PRD §5.3.2）
bankRouter.post('/exams/:examId/publish', async (c) => {
  const examId = c.req.param('examId');
  const exam = await c.env.DB.prepare('SELECT * FROM exams WHERE exam_id = ?').bind(examId).first();
  if (!exam) return c.json({ error: 'not_found' }, 404);

  const open = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM exam_parsing_notes WHERE exam_id = ? AND resolved = 0'
  ).bind(examId).first();
  if (open?.n > 0) {
    return c.json({
      error: 'unresolved_notes',
      message: `还有 ${open.n} 条存疑记录未处理，处理完才能发布整卷`,
      openNotes: open.n,
    }, 422);
  }

  // 标记为存疑的题目不随整卷发布
  await c.env.DB.prepare(
    `UPDATE questions SET status = '已发布' WHERE exam_id = ? AND status != '存疑'`
  ).bind(examId).run();
  await c.env.DB.prepare(
    `UPDATE exams SET status = '已发布', published_at = datetime('now') WHERE exam_id = ?`
  ).bind(examId).run();

  const counts = await c.env.DB.prepare(
    `SELECT SUM(CASE WHEN status = '已发布' THEN 1 ELSE 0 END) AS published,
            SUM(CASE WHEN status = '存疑' THEN 1 ELSE 0 END) AS held
     FROM questions WHERE exam_id = ?`
  ).bind(examId).first();

  return c.json({ ok: true, published: counts?.published || 0, held: counts?.held || 0 });
});

// 撤回发布
bankRouter.post('/exams/:examId/unpublish', async (c) => {
  const examId = c.req.param('examId');
  await c.env.DB.prepare(`UPDATE questions SET status = '草稿' WHERE exam_id = ? AND status = '已发布'`)
    .bind(examId).run();
  const res = await c.env.DB.prepare(
    `UPDATE exams SET status = '待校对', published_at = NULL WHERE exam_id = ?`
  ).bind(examId).run();
  if (!res.meta.changes) return c.json({ error: 'not_found' }, 404);
  return c.json({ ok: true });
});

// 考点标签库
bankRouter.get('/knowledge-points', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT k.tag_id, k.name, COUNT(x.question_id) AS question_count
     FROM knowledge_points k
     LEFT JOIN question_knowledge_points x ON x.tag_id = k.tag_id
     GROUP BY k.tag_id, k.name ORDER BY question_count DESC, k.name`
  ).all();
  return c.json({ knowledgePoints: results });
});
