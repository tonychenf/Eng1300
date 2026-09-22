import { Hono } from 'hono';
import { masteryTier } from '../lib/mastery.js';

export const adminStatsRouter = new Hono();

// ---------------- 学情看板 ----------------

// 每个学员一行：考了几次、平均分、练了多少、还剩多少错题没订正、最近在用是什么时候。
// 一次查询拿全，避免按用户循环发 N 次请求。
adminStatsRouter.get('/students', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.disabled, u.last_login_at,
            (SELECT COUNT(*) FROM attempts a
              WHERE a.user_id = u.id AND a.mode = 'EXAM' AND a.status = '已交卷') AS exam_count,
            (SELECT ROUND(AVG(a.objective_score), 1) FROM attempts a
              WHERE a.user_id = u.id AND a.mode = 'EXAM' AND a.status = '已交卷') AS avg_objective,
            (SELECT MAX(a.objective_score) FROM attempts a
              WHERE a.user_id = u.id AND a.mode = 'EXAM' AND a.status = '已交卷') AS best_objective,
            (SELECT COUNT(*) FROM attempts a
              WHERE a.user_id = u.id AND a.mode = 'PRACTICE') AS practice_count,
            (SELECT COUNT(*) FROM answer_records r
               JOIN attempts a ON a.attempt_id = r.attempt_id
              WHERE a.user_id = u.id AND r.is_correct IS NOT NULL) AS answered,
            (SELECT COUNT(*) FROM wrong_items w
              WHERE w.user_id = u.id AND w.corrected = 0) AS wrong_open,
            (SELECT COUNT(*) FROM wrong_items w
              WHERE w.user_id = u.id AND w.corrected = 1) AS wrong_cleared,
            (SELECT MAX(a.started_at) FROM attempts a WHERE a.user_id = u.id) AS last_activity
       FROM users u
      WHERE u.role = 'USER'
      ORDER BY u.username`
  ).all();
  return c.json({ students: results });
});

// 单个学员的详情：掌握度分档 + 最近几次成绩
adminStatsRouter.get('/students/:id', async (c) => {
  const id = Number(c.req.param('id'));
  const user = await c.env.DB.prepare(
    "SELECT id, username, disabled, created_at, last_login_at FROM users WHERE id = ? AND role = 'USER'"
  ).bind(id).first();
  if (!user) return c.json({ error: 'not_found' }, 404);

  const { results: mastery } = await c.env.DB.prepare(
    `SELECT m.tag_id, k.name, m.correct_count, m.wrong_count, m.consecutive_correct, m.last_result
       FROM user_knowledge_mastery m JOIN knowledge_points k ON k.tag_id = m.tag_id
      WHERE m.user_id = ?`
  ).bind(id).all();

  const tierCount = {};
  const scored = mastery.map((r) => {
    const tier = masteryTier(r);
    tierCount[tier] = (tierCount[tier] || 0) + 1;
    return {
      name: r.name, tier,
      correct: r.correct_count, total: r.correct_count + r.wrong_count,
    };
  }).sort((a, b) => a.correct / (a.total || 1) - b.correct / (b.total || 1));

  const { results: attempts } = await c.env.DB.prepare(
    `SELECT attempt_id, mode, status, objective_score, total_score, started_at, submitted_at,
            duration_seconds, practice_stage
       FROM attempts WHERE user_id = ? ORDER BY started_at DESC LIMIT 20`
  ).bind(id).all();

  return c.json({ user, tierCount, mastery: scored, attempts });
});

// 全站概览：给后台首页用
adminStatsRouter.get('/overview', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM users WHERE role = 'USER') AS students,
       (SELECT COUNT(*) FROM users WHERE role = 'USER' AND disabled = 1) AS disabled_students,
       (SELECT COUNT(*) FROM attempts WHERE mode = 'EXAM' AND status = '已交卷') AS exams_done,
       (SELECT COUNT(*) FROM attempts WHERE mode = 'PRACTICE') AS practices,
       (SELECT COUNT(*) FROM answer_records WHERE is_correct IS NOT NULL) AS answers,
       (SELECT COUNT(*) FROM wrong_items WHERE corrected = 0) AS wrong_open,
       (SELECT COUNT(*) FROM questions WHERE status = '已发布') AS questions_live,
       (SELECT COUNT(*) FROM questions WHERE status = '存疑') AS questions_held`
  ).first();
  return c.json({ overview: row });
});

// ---------------- 数据导出（PRD §11 数据备份） ----------------

function jsonDownload(c, name, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="${name}"`,
    },
  });
}

// 题库导出：整卷结构与题目，含考点标签与存疑记录
adminStatsRouter.get('/export/bank', async (c) => {
  const courseCode = c.req.query('courseCode') || null;
  const examId = c.req.query('examId') || null;

  const conds = [];
  const binds = [];
  if (courseCode) { conds.push('e.course_code = ?'); binds.push(courseCode); }
  if (examId) { conds.push('e.exam_id = ?'); binds.push(examId); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const { results: exams } = await c.env.DB.prepare(
    `SELECT * FROM exams e ${where} ORDER BY e.course_code, e.year, e.month`
  ).bind(...binds).all();

  const out = [];
  for (const e of exams) {
    const { results: sections } = await c.env.DB.prepare(
      'SELECT * FROM sections WHERE exam_id = ? ORDER BY ord'
    ).bind(e.exam_id).all();
    const { results: questions } = await c.env.DB.prepare(
      `SELECT q.*, (SELECT group_concat(k.name, '||') FROM question_knowledge_points x
                      JOIN knowledge_points k ON k.tag_id = x.tag_id
                     WHERE x.question_id = q.question_id) AS tag_names
         FROM questions q WHERE q.exam_id = ? ORDER BY q.ord`
    ).bind(e.exam_id).all();
    const { results: notes } = await c.env.DB.prepare(
      'SELECT note, resolved, resolved_at FROM exam_parsing_notes WHERE exam_id = ? ORDER BY id'
    ).bind(e.exam_id).all();

    out.push({
      ...e,
      parsingNotes: notes,
      sections: sections.map((s) => ({
        ...s,
        questions: questions.filter((q) => q.section_id === s.section_id).map((q) => ({
          ...q,
          options: q.options ? JSON.parse(q.options) : null,
          knowledgePoints: q.tag_names ? q.tag_names.split('||') : [],
          tag_names: undefined,
        })),
      })),
    });
  }

  return jsonDownload(c, `eng1300-bank-${new Date().toISOString().slice(0, 10)}.json`, {
    exportedAt: new Date().toISOString(),
    kind: 'bank',
    filter: { courseCode, examId },
    examCount: out.length,
    exams: out,
  });
});

// 作答记录导出：可按学员筛选，不带则导全部
adminStatsRouter.get('/export/records', async (c) => {
  const userId = c.req.query('userId') ? Number(c.req.query('userId')) : null;

  const attemptWhere = userId ? 'WHERE a.user_id = ?' : '';
  const binds = userId ? [userId] : [];

  const { results: attempts } = await c.env.DB.prepare(
    `SELECT a.*, u.username FROM attempts a JOIN users u ON u.id = a.user_id
     ${attemptWhere} ORDER BY a.started_at`
  ).bind(...binds).all();

  const { results: answers } = await c.env.DB.prepare(
    `SELECT r.*, a.user_id FROM answer_records r JOIN attempts a ON a.attempt_id = r.attempt_id
     ${userId ? 'WHERE a.user_id = ?' : ''} ORDER BY r.id`
  ).bind(...binds).all();

  const { results: wrong } = await c.env.DB.prepare(
    `SELECT w.*, u.username FROM wrong_items w JOIN users u ON u.id = w.user_id
     ${userId ? 'WHERE w.user_id = ?' : ''} ORDER BY w.id`
  ).bind(...binds).all();

  const { results: mastery } = await c.env.DB.prepare(
    `SELECT m.*, u.username, k.name AS tag_name
       FROM user_knowledge_mastery m
       JOIN users u ON u.id = m.user_id
       JOIN knowledge_points k ON k.tag_id = m.tag_id
     ${userId ? 'WHERE m.user_id = ?' : ''} ORDER BY m.user_id, m.tag_id`
  ).bind(...binds).all();

  return jsonDownload(c, `eng1300-records-${new Date().toISOString().slice(0, 10)}.json`, {
    exportedAt: new Date().toISOString(),
    kind: 'records',
    filter: { userId },
    counts: {
      attempts: attempts.length, answers: answers.length,
      wrongItems: wrong.length, mastery: mastery.length,
    },
    attempts: attempts.map((a) => ({
      ...a,
      section_scores: a.section_scores ? JSON.parse(a.section_scores) : null,
      scope_section_types: a.scope_section_types ? JSON.parse(a.scope_section_types) : null,
    })),
    answers, wrongItems: wrong, mastery,
  });
});
