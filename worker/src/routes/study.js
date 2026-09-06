import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { masteryTier } from '../lib/mastery.js';
import { gradeEssay, analyzeWrong, assessAbility } from '../lib/tutor.js';

export const studyRouter = new Hono();
studyRouter.use('/wrongbook/*', requireAuth);
studyRouter.use('/wrongbook', requireAuth);
studyRouter.use('/assessment', requireAuth);
studyRouter.use('/ai/*', requireAuth);

// 近期权重：越靠后的一次占比越高（PRD §7.5）
const DECAY = [0.35, 0.25, 0.20, 0.12, 0.08];

// ---------------- 错题本 ----------------

studyRouter.get('/wrongbook', async (c) => {
  const me = c.get('user');
  const courseCode = c.req.query('courseCode') || null;
  const sectionType = c.req.query('sectionType') || null;
  const tagName = c.req.query('knowledgePoint') || null;
  const includeCorrected = c.req.query('includeCorrected') === '1';
  const limit = Math.min(Number(c.req.query('limit')) || 50, 200);
  const offset = Number(c.req.query('offset')) || 0;

  const conds = ['w.user_id = ?'];
  const binds = [me.id];
  if (courseCode) { conds.push('w.course_code = ?'); binds.push(courseCode); }
  if (sectionType) { conds.push('q.section_type = ?'); binds.push(sectionType); }
  if (!includeCorrected) conds.push('w.corrected = 0');
  if (tagName) {
    conds.push(`EXISTS (SELECT 1 FROM question_knowledge_points x
                        JOIN knowledge_points k ON k.tag_id = x.tag_id
                        WHERE x.question_id = w.question_id AND k.name = ?)`);
    binds.push(tagName);
  }

  const where = conds.join(' AND ');
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM wrong_items w JOIN questions q ON q.question_id = w.question_id
      WHERE ${where}`
  ).bind(...binds).first();

  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.question_id, w.course_code, w.source, w.wrong_count, w.streak_correct,
            w.error_analysis, w.memory_point, w.ai_status, w.corrected, w.updated_at,
            q.section_type, q.question_type, q.stem, q.options, q.answer, q.answer_explanation,
            (SELECT group_concat(k.name, '||') FROM question_knowledge_points x
               JOIN knowledge_points k ON k.tag_id = x.tag_id
              WHERE x.question_id = w.question_id) AS tag_names,
            (SELECT r.user_answer FROM answer_records r
              WHERE r.question_id = w.question_id AND r.attempt_id = w.last_attempt_id) AS last_answer
       FROM wrong_items w JOIN questions q ON q.question_id = w.question_id
      WHERE ${where}
      ORDER BY w.updated_at DESC
      LIMIT ? OFFSET ?`
  ).bind(...binds, limit, offset).all();

  return c.json({
    total: total?.n || 0,
    items: results.map((r) => ({
      id: r.id,
      questionId: r.question_id,
      courseCode: r.course_code,
      source: r.source === 'PRACTICE' ? '练习' : '模考',
      sectionType: r.section_type,
      questionType: r.question_type,
      stem: r.stem,
      options: r.options ? JSON.parse(r.options) : null,
      correctAnswer: r.answer,
      lastAnswer: r.last_answer,
      explanation: r.answer_explanation,
      knowledgePoints: r.tag_names ? r.tag_names.split('||') : [],
      wrongCount: r.wrong_count,
      streakCorrect: r.streak_correct,
      corrected: Boolean(r.corrected),
      errorAnalysis: r.error_analysis,
      memoryPoint: r.memory_point,
      aiStatus: r.ai_status,
      updatedAt: r.updated_at,
    })),
  });
});

// 错题本的筛选项：只列出真正有错题的题型与考点，避免选了个空条件
studyRouter.get('/wrongbook/filters', async (c) => {
  const me = c.get('user');
  const { results: types } = await c.env.DB.prepare(
    `SELECT q.section_type, COUNT(*) AS n
       FROM wrong_items w JOIN questions q ON q.question_id = w.question_id
      WHERE w.user_id = ? AND w.corrected = 0
      GROUP BY q.section_type ORDER BY n DESC`
  ).bind(me.id).all();
  const { results: tags } = await c.env.DB.prepare(
    `SELECT k.name, COUNT(*) AS n
       FROM wrong_items w
       JOIN question_knowledge_points x ON x.question_id = w.question_id
       JOIN knowledge_points k ON k.tag_id = x.tag_id
      WHERE w.user_id = ? AND w.corrected = 0
      GROUP BY k.name ORDER BY n DESC`
  ).bind(me.id).all();
  return c.json({ sectionTypes: types, knowledgePoints: tags });
});

// ---------------- AI 任务 ----------------

// 给一次模考补上 AI 结果：作文评分 + 错题分析。
// 交卷时不做这件事，是为了让客观题成绩先出来（PRD §5.5.3）。
studyRouter.post('/ai/attempts/:id/run', async (c) => {
  const me = c.get('user');
  const attemptId = c.req.param('id');
  const a = await c.env.DB.prepare('SELECT * FROM attempts WHERE attempt_id = ?')
    .bind(attemptId).first();
  if (!a) return c.json({ error: 'not_found' }, 404);
  if (a.user_id !== me.id) return c.json({ error: 'forbidden' }, 403);
  if (a.status === '进行中') return c.json({ error: 'not_submitted', message: '尚未交卷' }, 409);

  const result = { essay: null, wrongItems: { done: 0, failed: 0 } };

  // 1) 作文
  const { results: essays } = await c.env.DB.prepare(
    `SELECT aq.question_id, q.stem, s.writing_prompt, r.user_answer, r.ai_judged
       FROM attempt_questions aq
       JOIN questions q ON q.question_id = aq.question_id
       JOIN sections s ON s.section_id = aq.section_id
       LEFT JOIN answer_records r ON r.attempt_id = aq.attempt_id AND r.question_id = aq.question_id
      WHERE aq.attempt_id = ? AND q.question_type = 'essay'`
  ).bind(attemptId).all();

  for (const e of essays) {
    if (e.ai_judged) { result.essay = { status: 'already' }; continue; }
    if (!String(e.user_answer || '').trim()) {
      // 没写就是 0 分，不必花 AI 的钱
      await c.env.DB.prepare(
        `UPDATE answer_records SET is_correct = 0, score = 0, ai_judged = 1,
                ai_score = 0, ai_comment = '未作答'
          WHERE attempt_id = ? AND question_id = ?`
      ).bind(attemptId, e.question_id).run();
      result.essay = { status: 'blank', total: 0 };
      continue;
    }
    try {
      const graded = await gradeEssay(c.env, {
        prompt: e.writing_prompt || e.stem,
        essay: e.user_answer,
      });
      await c.env.DB.prepare(
        `UPDATE answer_records SET score = ?, ai_score = ?, ai_judged = 1, ai_comment = ?,
                is_correct = NULL
          WHERE attempt_id = ? AND question_id = ?`
      ).bind(graded.total, graded.total, JSON.stringify(graded), attemptId, e.question_id).run();
      result.essay = { status: 'graded', total: graded.total };
    } catch (err) {
      result.essay = { status: 'failed', error: err.code || String(err) };
    }
  }

  // 2) 错题分析
  const { results: pending } = await c.env.DB.prepare(
    `SELECT w.id, w.question_id, q.stem, q.options, q.answer, s.passage_text,
            r.user_answer,
            (SELECT group_concat(k.name, '||') FROM question_knowledge_points x
               JOIN knowledge_points k ON k.tag_id = x.tag_id
              WHERE x.question_id = w.question_id) AS tag_names
       FROM wrong_items w
       JOIN questions q ON q.question_id = w.question_id
       JOIN sections s ON s.section_id = q.section_id
       LEFT JOIN answer_records r ON r.question_id = w.question_id AND r.attempt_id = ?
      WHERE w.user_id = ? AND w.last_attempt_id = ? AND w.ai_status != '已生成'
      LIMIT 20`
  ).bind(attemptId, me.id, attemptId).all();

  for (const w of pending) {
    try {
      const out = await analyzeWrong(c.env, {
        stem: w.stem,
        options: w.options ? JSON.parse(w.options) : null,
        userAnswer: w.user_answer,
        correctAnswer: w.answer,
        knowledgePoints: w.tag_names ? w.tag_names.split('||') : [],
        passage: w.passage_text,
      });
      await c.env.DB.prepare(
        `UPDATE wrong_items SET error_analysis = ?, memory_point = ?, ai_status = '已生成',
                updated_at = datetime('now') WHERE id = ?`
      ).bind(out.errorReason, out.memoryPoint, w.id).run();
      result.wrongItems.done++;
    } catch {
      await c.env.DB.prepare(
        `UPDATE wrong_items SET ai_status = '待重试' WHERE id = ?`
      ).bind(w.id).run();
      result.wrongItems.failed++;
    }
  }

  // 作文批改完要把总分补上
  await c.env.DB.prepare(
    `UPDATE attempts SET
       total_score = (SELECT COALESCE(SUM(score), 0) FROM answer_records WHERE attempt_id = ?),
       pending_ai = (SELECT COUNT(*) FROM attempt_questions aq
                       JOIN questions q ON q.question_id = aq.question_id
                       LEFT JOIN answer_records r ON r.attempt_id = aq.attempt_id
                                                 AND r.question_id = aq.question_id
                      WHERE aq.attempt_id = ? AND q.question_type = 'essay'
                        AND COALESCE(r.ai_judged, 0) = 0)
     WHERE attempt_id = ?`
  ).bind(attemptId, attemptId, attemptId).run();

  return c.json({ ok: true, ...result });
});

// ---------------- 能力评估 ----------------

studyRouter.get('/assessment', async (c) => {
  const me = c.get('user');
  const courseCode = c.req.query('courseCode');
  if (!courseCode) return c.json({ error: 'invalid_request', message: '缺少 courseCode' }, 400);

  const { results: exams } = await c.env.DB.prepare(
    `SELECT attempt_id, total_score, objective_score, section_scores, submitted_at
       FROM attempts
      WHERE user_id = ? AND course_code = ? AND mode = 'EXAM' AND status = '已交卷'
      ORDER BY submitted_at DESC LIMIT 5`
  ).bind(me.id, courseCode).all();

  const { results: masteryRows } = await c.env.DB.prepare(
    `SELECT m.tag_id, k.name, m.correct_count, m.wrong_count, m.consecutive_correct, m.last_result
       FROM user_knowledge_mastery m JOIN knowledge_points k ON k.tag_id = m.tag_id
      WHERE m.user_id = ? AND m.course_code = ?`
  ).bind(me.id, courseCode).all();

  const mastery = masteryRows.map((r) => ({
    tagId: r.tag_id,
    name: r.name,
    correct: r.correct_count,
    total: r.correct_count + r.wrong_count,
    tier: masteryTier(r),
  })).sort((a, b) => a.correct / (a.total || 1) - b.correct / (b.total || 1));

  const tierCount = mastery.reduce((acc, m) => {
    acc[m.tier] = (acc[m.tier] || 0) + 1;
    return acc;
  }, {});

  // 样本不足 2 次时不给预测——一次考试的预测没有意义（PRD §5.8）
  if (exams.length < 2) {
    return c.json({
      enoughData: false,
      message: `再完成 ${2 - exams.length} 次模考即可生成预测`,
      examCount: exams.length,
      mastery, tierCount,
      trend: exams.map((e) => ({ score: e.total_score, at: e.submitted_at })).reverse(),
    });
  }

  // 统计层：按部分算近期得分率，时间衰减加权
  const bySection = new Map();
  exams.forEach((e, i) => {
    const w = DECAY[i] ?? 0;
    const secs = e.section_scores ? JSON.parse(e.section_scores) : [];
    for (const s of secs) {
      if (!bySection.has(s.sectionOrd)) {
        bySection.set(s.sectionOrd, { sectionType: s.sectionType, maxScore: s.maxScore, num: 0, den: 0 });
      }
      const acc = bySection.get(s.sectionOrd);
      // 作文未批改时该次不计入，避免把"待批改"当成 0 分拉低预测
      if (s.pendingAi) continue;
      acc.num += (s.maxScore ? s.score / s.maxScore : 0) * w;
      acc.den += w;
    }
  });

  const sectionPrediction = [...bySection.entries()].map(([ord, v]) => ({
    sectionOrd: Number(ord),
    sectionType: v.sectionType,
    maxScore: v.maxScore,
    rate: v.den ? v.num / v.den : null,
    predicted: v.den ? Math.round(v.maxScore * (v.num / v.den) * 10) / 10 : null,
  })).sort((a, b) => a.sectionOrd - b.sectionOrd);

  const predicted = Math.round(
    sectionPrediction.reduce((n, s) => n + (s.predicted || 0), 0) * 10
  ) / 10;

  const totals = exams.map((e) => e.total_score).filter((v) => typeof v === 'number');
  const mean = totals.reduce((a, b) => a + b, 0) / (totals.length || 1);
  const sd = Math.sqrt(totals.reduce((a, b) => a + (b - mean) ** 2, 0) / (totals.length || 1));
  const band = Math.max(3, Math.round(sd * 10) / 10);

  return c.json({
    enoughData: true,
    examCount: exams.length,
    statistical: {
      predicted,
      low: Math.max(0, Math.round((predicted - band) * 10) / 10),
      high: Math.min(100, Math.round((predicted + band) * 10) / 10),
      sections: sectionPrediction,
    },
    mastery,
    tierCount,
    trend: exams.map((e) => ({ score: e.total_score, at: e.submitted_at })).reverse(),
  });
});

// AI 定性层单独一个接口：统计层要立刻出，AI 慢就慢在这里，互不阻塞
studyRouter.post('/ai/assessment', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const courseCode = body.courseCode;
  if (!courseCode) return c.json({ error: 'invalid_request', message: '缺少 courseCode' }, 400);

  const { results: masteryRows } = await c.env.DB.prepare(
    `SELECT m.tag_id, k.name, m.correct_count, m.wrong_count, m.consecutive_correct, m.last_result
       FROM user_knowledge_mastery m JOIN knowledge_points k ON k.tag_id = m.tag_id
      WHERE m.user_id = ? AND m.course_code = ?`
  ).bind(me.id, courseCode).all();

  const { results: wrongTags } = await c.env.DB.prepare(
    `SELECT k.name, COUNT(*) AS n
       FROM wrong_items w
       JOIN question_knowledge_points x ON x.question_id = w.question_id
       JOIN knowledge_points k ON k.tag_id = x.tag_id
      WHERE w.user_id = ? AND w.course_code = ? AND w.corrected = 0
      GROUP BY k.name ORDER BY n DESC LIMIT 5`
  ).bind(me.id, courseCode).all();

  const { results: trend } = await c.env.DB.prepare(
    `SELECT total_score FROM attempts
      WHERE user_id = ? AND course_code = ? AND mode = 'EXAM' AND status = '已交卷'
      ORDER BY submitted_at LIMIT 10`
  ).bind(me.id, courseCode).all();

  try {
    const out = await assessAbility(c.env, {
      mastery: masteryRows.map((r) => ({
        name: r.name, correct: r.correct_count,
        total: r.correct_count + r.wrong_count, tier: masteryTier(r),
      })),
      recentWrongTags: wrongTags.map((w) => w.name),
      scoreTrend: trend.map((t) => t.total_score),
      totalScore: body.statPredicted ?? null,
    });
    await c.env.DB.prepare(
      `INSERT INTO assessments (user_id, course_code, stat_predicted_score, ai_predicted_low,
                                ai_predicted_high, ai_level_desc, weak_points, suggestions, ai_status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '已生成')`
    ).bind(me.id, courseCode, body.statPredicted ?? null, out.predictedLow, out.predictedHigh,
           out.levelDesc, JSON.stringify(out.weakPoints), JSON.stringify(out.suggestions)).run();
    return c.json({ ok: true, ai: out });
  } catch (err) {
    return c.json({
      ok: false,
      error: err.code || 'ai_unavailable',
      message: 'AI 评估暂时不可用，统计预测不受影响',
    }, 503);
  }
});
