import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { gradeQuestion } from '../lib/grade.js';
import { masteryTier, masteryWrites, tagsOfQuestion } from '../lib/mastery.js';
import { nextQuestion, scopeTags, scopeQuestionCount } from '../lib/practice.js';

export const practiceRouter = new Hono();
practiceRouter.use('/practice/*', requireAuth);

function newId() {
  return `prc-${crypto.randomUUID()}`;
}

async function settingInt(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(key).first();
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : fallback;
}

async function loadPractice(c, id) {
  const me = c.get('user');
  const a = await c.env.DB.prepare(
    "SELECT * FROM attempts WHERE attempt_id = ? AND mode = 'PRACTICE'"
  ).bind(id).first();
  if (!a) return { error: 'not_found', status: 404 };
  if (a.user_id !== me.id) return { error: 'forbidden', status: 403 };
  return { attempt: a };
}

// 未完成的练习，用于"上次还没做完，要继续吗"
practiceRouter.get('/practice/active', async (c) => {
  const me = c.get('user');
  const courseCode = c.req.query('courseCode');
  const row = await c.env.DB.prepare(
    `SELECT a.attempt_id, a.course_code, a.practice_stage, a.started_at,
            (SELECT COUNT(*) FROM attempt_questions q WHERE q.attempt_id = a.attempt_id) AS asked
       FROM attempts a
      WHERE a.user_id = ? AND a.mode = 'PRACTICE' AND a.status = '进行中'
        AND (? IS NULL OR a.course_code = ?)
      ORDER BY a.started_at DESC LIMIT 1`
  ).bind(me.id, courseCode ?? null, courseCode ?? null).first();
  return c.json({ active: row || null });
});

// 练习范围预览：这个范围里有多少考点、多少题
practiceRouter.get('/practice/scope', async (c) => {
  const courseCode = c.req.query('courseCode');
  if (!courseCode) return c.json({ error: 'invalid_request', message: '缺少 courseCode' }, 400);
  const sectionTypes = c.req.query('sectionTypes')?.split(',').filter(Boolean) || null;
  const scope = { courseCode, sectionTypes, knowledgePoints: null };
  const tags = await scopeTags(c.env.DB, scope);
  const questionCount = await scopeQuestionCount(c.env.DB, scope);
  return c.json({ knowledgePoints: tags, questionCount });
});

// 该课程可选的题型
practiceRouter.get('/practice/section-types', async (c) => {
  const courseCode = c.req.query('courseCode');
  const { results } = await c.env.DB.prepare(
    `SELECT section_type, COUNT(*) AS question_count
       FROM questions WHERE course_code = ? AND status = '已发布'
      GROUP BY section_type ORDER BY section_type`
  ).bind(courseCode).all();
  return c.json({ sectionTypes: results });
});

practiceRouter.post('/practice/start', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const { courseCode } = body;
  if (!courseCode) return c.json({ error: 'invalid_request', message: '缺少 courseCode' }, 400);

  const course = await c.env.DB.prepare('SELECT * FROM courses WHERE course_code = ?')
    .bind(courseCode).first();
  if (!course) return c.json({ error: 'not_found', message: '课程不存在' }, 404);

  const sectionTypes = Array.isArray(body.sectionTypes) && body.sectionTypes.length
    ? body.sectionTypes : null;
  const scope = { courseCode, sectionTypes, knowledgePoints: null };

  const count = await scopeQuestionCount(c.env.DB, scope);
  if (!count) {
    return c.json({
      error: 'insufficient_questions',
      message: '所选范围内没有可用题目，请放宽题型范围',
    }, 422);
  }

  const attemptId = newId();
  await c.env.DB.prepare(
    `INSERT INTO attempts (attempt_id, user_id, course_code, mode, status, practice_stage,
                           scope_section_types, time_limit_minutes)
     VALUES (?, ?, ?, 'PRACTICE', '进行中', '摸底', ?, 0)`
  ).bind(attemptId, me.id, courseCode, sectionTypes ? JSON.stringify(sectionTypes) : null).run();

  const tags = await scopeTags(c.env.DB, scope);
  return c.json({
    attemptId, courseCode, stage: '摸底',
    knowledgePointCount: tags.length, questionCount: count,
  }, 201);
});

// 单考点专项：把某个考点下的题全部做一遍
practiceRouter.post('/practice/drill', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const { courseCode, tagId } = body;
  if (!courseCode || !tagId) {
    return c.json({ error: 'invalid_request', message: '缺少 courseCode 或 tagId' }, 400);
  }
  const scope = { courseCode, sectionTypes: null, knowledgePoints: [tagId] };
  const count = await scopeQuestionCount(c.env.DB, scope);
  if (!count) return c.json({ error: 'insufficient_questions', message: '该考点下没有可用题目' }, 422);

  const attemptId = newId();
  await c.env.DB.prepare(
    `INSERT INTO attempts (attempt_id, user_id, course_code, mode, status, practice_stage,
                           scope_knowledge_point, time_limit_minutes)
     VALUES (?, ?, ?, 'PRACTICE', '进行中', '单考点专项', ?, 0)`
  ).bind(attemptId, me.id, courseCode, tagId).run();

  return c.json({ attemptId, courseCode, stage: '单考点专项', questionCount: count }, 201);
});

// 取下一题。由服务端按算法决定，前端不参与选题。
practiceRouter.get('/practice/:id/next', async (c) => {
  const loaded = await loadPractice(c, c.req.param('id'));
  if (loaded.error) return c.json({ error: loaded.error }, loaded.status);
  const a = loaded.attempt;
  if (a.status !== '进行中') return c.json({ error: 'already_submitted', message: '本次练习已结束' }, 409);

  const batchSize = await settingInt(c.env.DB, 'practice.diagnostic_batch_size', 40);
  const recentWindow = await settingInt(c.env.DB, 'practice.reinforce_recent_window', 20);
  const pick = await nextQuestion(c.env.DB, a, { batchSize, recentWindow });

  if (pick.done) {
    return c.json({ done: true, reason: pick.reason, message: '这个范围内的题都做完了，可以结束练习看总结' });
  }

  const q = await c.env.DB.prepare(
    `SELECT q.*, s.type AS section_type, s.passage_title, s.passage_text, s.writing_prompt
       FROM questions q JOIN sections s ON s.section_id = q.section_id
      WHERE q.question_id = ?`
  ).bind(pick.questionId).first();

  const ordRow = await c.env.DB.prepare(
    'SELECT COALESCE(MAX(ord), 0) AS m FROM attempt_questions WHERE attempt_id = ?'
  ).bind(a.attempt_id).first();
  const ord = (ordRow?.m || 0) + 1;

  await c.env.DB.prepare(
    `INSERT INTO attempt_questions
       (attempt_id, ord, question_id, section_id, section_ord, score_per_question)
     VALUES (?, ?, ?, ?, 0, 0)`
  ).bind(a.attempt_id, ord, q.question_id, q.section_id).run();

  if (pick.stage !== a.practice_stage) {
    await c.env.DB.prepare('UPDATE attempts SET practice_stage = ? WHERE attempt_id = ?')
      .bind(pick.stage, a.attempt_id).run();
  }

  return c.json({
    stage: pick.stage,
    ord,
    question: {
      ord,
      questionId: q.question_id,
      questionType: q.question_type,
      stem: q.stem,
      options: q.options ? JSON.parse(q.options) : null,
      sectionType: q.section_type,
      passageTitle: q.passage_title,
      passageText: q.passage_text,
      writingPrompt: q.writing_prompt,
    },
  });
});

// 提交答案，同步返回对错与解析
practiceRouter.post('/practice/:id/answer', async (c) => {
  const loaded = await loadPractice(c, c.req.param('id'));
  if (loaded.error) return c.json({ error: loaded.error }, loaded.status);
  const a = loaded.attempt;
  if (a.status !== '进行中') return c.json({ error: 'already_submitted', message: '本次练习已结束' }, 409);

  const body = await c.req.json().catch(() => ({}));
  const { questionId } = body;
  if (!questionId) return c.json({ error: 'invalid_request', message: '缺少 questionId' }, 400);

  const belongs = await c.env.DB.prepare(
    'SELECT 1 AS ok FROM attempt_questions WHERE attempt_id = ? AND question_id = ?'
  ).bind(a.attempt_id, questionId).first();
  if (!belongs) return c.json({ error: 'not_found', message: '这道题不在本次练习中' }, 404);

  const already = await c.env.DB.prepare(
    'SELECT is_correct FROM answer_records WHERE attempt_id = ? AND question_id = ?'
  ).bind(a.attempt_id, questionId).first();
  if (already && already.is_correct !== null) {
    return c.json({ error: 'already_answered', message: '这道题已经作答过了' }, 409);
  }

  const q = await c.env.DB.prepare('SELECT * FROM questions WHERE question_id = ?')
    .bind(questionId).first();

  // 练习不计分，只判对错；作文这一期没有 AI 批改，先不纳入练习
  const g = gradeQuestion(q, body.answer, 0);
  const isCorrect = g.isCorrect;

  const tagIds = await tagsOfQuestion(c.env.DB, questionId);
  const writes = [
    c.env.DB.prepare(
      `INSERT INTO answer_records (attempt_id, question_id, user_answer, is_correct, score, answered_at)
       VALUES (?, ?, ?, ?, 0, datetime('now'))
       ON CONFLICT(attempt_id, question_id) DO UPDATE SET
         user_answer = excluded.user_answer, is_correct = excluded.is_correct,
         answered_at = excluded.answered_at`
    ).bind(a.attempt_id, questionId, body.answer ?? null, isCorrect),
  ];
  if (isCorrect !== null) {
    writes.push(...(await masteryWrites(c.env.DB, a.user_id, a.course_code,
      [{ tagIds, isCorrect }])));
  }
  await c.env.DB.batch(writes);

  const { results: names } = tagIds.length
    ? await c.env.DB.prepare(
        `SELECT name FROM knowledge_points WHERE tag_id IN (${tagIds.map(() => '?').join(',')})`
      ).bind(...tagIds).all()
    : { results: [] };

  return c.json({
    isCorrect,
    correctAnswer: q.answer,
    explanation: q.answer_explanation,
    knowledgePoints: names.map((n) => n.name),
    // AI 解析属于 M5，这一期先给题库里的官方解析
    aiExplanation: null,
  });
});

practiceRouter.post('/practice/:id/end', async (c) => {
  const loaded = await loadPractice(c, c.req.param('id'));
  if (loaded.error) return c.json({ error: loaded.error }, loaded.status);
  const a = loaded.attempt;
  if (a.status !== '进行中') return c.json({ ok: true, alreadyEnded: true });

  await c.env.DB.prepare(
    `UPDATE attempts SET status = '已结束', submitted_at = datetime('now'),
            duration_seconds = CAST(strftime('%s','now') - strftime('%s', started_at) AS INTEGER)
      WHERE attempt_id = ?`
  ).bind(a.attempt_id).run();
  return c.json({ ok: true });
});

practiceRouter.get('/practice/:id/summary', async (c) => {
  const loaded = await loadPractice(c, c.req.param('id'));
  if (loaded.error) return c.json({ error: loaded.error }, loaded.status);
  const a = loaded.attempt;

  const stat = await c.env.DB.prepare(
    `SELECT COUNT(*) AS answered,
            SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct
       FROM answer_records WHERE attempt_id = ? AND is_correct IS NOT NULL`
  ).bind(a.attempt_id).first();

  // 本次练习覆盖到的考点，连同该用户在这些考点上的整体掌握度
  const { results: tags } = await c.env.DB.prepare(
    `SELECT k.tag_id, k.name,
            SUM(CASE WHEN r.is_correct = 1 THEN 1 ELSE 0 END) AS session_correct,
            COUNT(*) AS session_total,
            m.correct_count, m.wrong_count, m.consecutive_correct, m.last_result
       FROM answer_records r
       JOIN question_knowledge_points x ON x.question_id = r.question_id
       JOIN knowledge_points k ON k.tag_id = x.tag_id
       LEFT JOIN user_knowledge_mastery m
              ON m.tag_id = k.tag_id AND m.user_id = ? AND m.course_code = ?
      WHERE r.attempt_id = ? AND r.is_correct IS NOT NULL
      GROUP BY k.tag_id, k.name`
  ).bind(a.user_id, a.course_code, a.attempt_id).all();

  const scored = tags.map((t) => ({
    tagId: t.tag_id,
    name: t.name,
    sessionCorrect: t.session_correct,
    sessionTotal: t.session_total,
    tier: masteryTier(t),
  }));
  const order = { 薄弱: 0, 待巩固: 1, 已掌握: 2, 未测: 3 };
  scored.sort((x, y) => (order[x.tier] - order[y.tier])
    || (x.sessionCorrect / x.sessionTotal) - (y.sessionCorrect / y.sessionTotal));

  const weak = scored.filter((t) => t.tier === '薄弱');
  const consolidate = scored.filter((t) => t.tier === '待巩固');

  // 规则生成的建议。AI 版本属于 M5，届时替换这里。
  const suggestions = [];
  if (weak.length) {
    suggestions.push(`优先补 ${weak.slice(0, 3).map((t) => t.name).join('、')}：这几个考点最近答错，建议逐个做专项练习。`);
  }
  if (consolidate.length) {
    suggestions.push(`${consolidate.slice(0, 3).map((t) => t.name).join('、')} 已有起色但还不稳，隔一天再练一轮确认。`);
  }
  const rate = stat?.answered ? (stat.correct || 0) / stat.answered : 0;
  if (stat?.answered >= 5) {
    suggestions.push(rate >= 0.8
      ? '本次正确率不错，可以把题型范围放宽，或者去做一套完整模考检验。'
      : '本次正确率偏低，建议缩小到一两个题型集中练，比铺开练效率高。');
  }

  return c.json({
    attempt: {
      attemptId: a.attempt_id,
      courseCode: a.course_code,
      stage: a.practice_stage,
      status: a.status,
      startedAt: a.started_at,
      endedAt: a.submitted_at,
      durationSeconds: a.duration_seconds,
    },
    stats: {
      answered: stat?.answered || 0,
      correct: stat?.correct || 0,
      accuracy: stat?.answered ? Math.round(rate * 100) : 0,
      knowledgePointCount: scored.length,
    },
    knowledgePoints: scored,
    weakPoints: weak,
    suggestions: suggestions.slice(0, 3),
  });
});
