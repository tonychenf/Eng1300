import { Hono } from 'hono';
import { planPaper } from '../lib/paper.js';
import { gradeQuestion } from '../lib/grade.js';
import { requireAuth } from '../lib/auth.js';

export const examRouter = new Hono();

// 按具体前缀挂鉴权，不用 '*'：这个路由挂在 /api 下，
// 用 '*' 会把 /api/health 和 /api/auth/login 一起挡住。
examRouter.use('/exams/*', requireAuth);
examRouter.use('/attempts/*', requireAuth);
examRouter.use('/history', requireAuth);

const DIFFICULTIES = ['随机', '简单', '正常', '困难'];

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function settingInt(db, key, fallback) {
  const row = await db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(key).first();
  const n = Number(row?.value);
  return Number.isFinite(n) ? n : fallback;
}

// 取一次作答，顺带算出服务端口径的剩余时间。
// 倒计时一律按 started_at 到现在的真实流逝算，关页面不暂停。
async function loadAttempt(db, attemptId, userId) {
  const a = await db.prepare(
    `SELECT *, CAST(strftime('%s','now') - strftime('%s', started_at) AS INTEGER) AS elapsed_seconds
       FROM attempts WHERE attempt_id = ?`
  ).bind(attemptId).first();
  if (!a) return { error: 'not_found', status: 404 };
  if (a.user_id !== userId) return { error: 'forbidden', status: 403 };
  const limit = a.time_limit_minutes * 60;
  return {
    attempt: a,
    elapsed: a.elapsed_seconds,
    remaining: Math.max(0, limit - a.elapsed_seconds),
    expired: a.status === '进行中' && a.elapsed_seconds >= limit,
  };
}

// 整卷内容：按部分分组，附带已保存的答案
async function loadPaper(db, attemptId, { withAnswers = true, withCorrect = false } = {}) {
  const { results } = await db.prepare(
    `SELECT aq.ord, aq.section_ord, aq.score_per_question,
            q.question_id, q.question_type, q.stem, q.options,
            s.section_id, s.type AS section_type, s.passage_title, s.passage_text, s.writing_prompt,
            ${withCorrect ? 'q.answer AS correct_answer, q.answer_explanation,' : ''}
            r.user_answer, r.is_correct, r.score, r.ai_judged, r.ai_comment
       FROM attempt_questions aq
       JOIN questions q ON q.question_id = aq.question_id
       JOIN sections s ON s.section_id = aq.section_id
       LEFT JOIN answer_records r ON r.attempt_id = aq.attempt_id AND r.question_id = aq.question_id
      WHERE aq.attempt_id = ?
      ORDER BY aq.ord`
  ).bind(attemptId).all();

  const sections = [];
  for (const row of results) {
    let sec = sections.find((s) => s.sectionOrd === row.section_ord);
    if (!sec) {
      sec = {
        sectionOrd: row.section_ord,
        sectionType: row.section_type,
        passageTitle: row.passage_title,
        passageText: row.passage_text,
        writingPrompt: row.writing_prompt,
        scorePerQuestion: row.score_per_question,
        questions: [],
      };
      sections.push(sec);
    }
    const q = {
      ord: row.ord,
      questionId: row.question_id,
      questionType: row.question_type,
      stem: row.stem,
      options: row.options ? JSON.parse(row.options) : null,
    };
    if (withAnswers) q.userAnswer = row.user_answer ?? null;
    if (withCorrect) {
      q.correctAnswer = row.correct_answer;
      q.explanation = row.answer_explanation;
      q.isCorrect = row.is_correct;
      q.score = row.score;
      q.aiJudged = Boolean(row.ai_judged);
      q.aiComment = row.ai_comment;
    }
    sec.questions.push(q);
  }
  return sections;
}

// 判分并落库。已交卷的直接返回，不重复判。
async function submitAttempt(db, attempt, { auto = false }) {
  const { results: rows } = await db.prepare(
    `SELECT aq.ord, aq.section_ord, aq.score_per_question, q.question_id, q.question_type, q.answer,
            s.type AS section_type, r.user_answer
       FROM attempt_questions aq
       JOIN questions q ON q.question_id = aq.question_id
       JOIN sections s ON s.section_id = aq.section_id
       LEFT JOIN answer_records r ON r.attempt_id = aq.attempt_id AND r.question_id = aq.question_id
      WHERE aq.attempt_id = ? ORDER BY aq.ord`
  ).bind(attempt.attempt_id).all();

  const bySection = new Map();
  const writes = [];
  let objective = 0;
  let pendingAi = 0;
  let unreviewed = 0;

  for (const row of rows) {
    const g = gradeQuestion(row, row.user_answer, row.score_per_question);
    if (g.score !== null) objective += g.score;
    if (row.question_type === 'essay') pendingAi++;
    else if (g.needsAiReview) unreviewed++;

    writes.push(
      db.prepare(
        `INSERT INTO answer_records (attempt_id, question_id, user_answer, is_correct, score, answered_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(attempt_id, question_id) DO UPDATE SET
           is_correct = excluded.is_correct, score = excluded.score`
      ).bind(attempt.attempt_id, row.question_id, row.user_answer ?? null, g.isCorrect, g.score)
    );

    let sec = bySection.get(row.section_ord);
    if (!sec) {
      sec = {
        sectionOrd: row.section_ord, sectionType: row.section_type,
        score: 0, maxScore: 0, correct: 0, total: 0, pendingAi: 0,
      };
      bySection.set(row.section_ord, sec);
    }
    sec.total++;
    sec.maxScore += row.score_per_question;
    if (g.score !== null) sec.score += g.score;
    if (g.isCorrect === 1) sec.correct++;
    if (g.isCorrect === null) sec.pendingAi++;
  }

  const sectionScores = [...bySection.values()].sort((a, b) => a.sectionOrd - b.sectionOrd);
  objective = Math.round(objective * 100) / 100;

  writes.push(
    db.prepare(
      `UPDATE attempts SET status = '已交卷', submitted_at = datetime('now'),
              duration_seconds = CAST(strftime('%s','now') - strftime('%s', started_at) AS INTEGER),
              objective_score = ?, total_score = ?, section_scores = ?, pending_ai = ?
        WHERE attempt_id = ? AND status = '进行中'`
    ).bind(objective, objective, JSON.stringify(sectionScores), pendingAi, attempt.attempt_id)
  );

  // 掌握度：M4 的自适应出题要用，判分时顺手累计，只算客观题
  writes.push(
    db.prepare(
      `INSERT INTO user_knowledge_mastery
         (user_id, course_code, tag_id, correct_count, wrong_count, consecutive_correct,
          last_result, last_practiced_at)
       SELECT ?, ?, x.tag_id,
              SUM(CASE WHEN r.is_correct = 1 THEN 1 ELSE 0 END),
              SUM(CASE WHEN r.is_correct = 0 THEN 1 ELSE 0 END),
              0, NULL, datetime('now')
         FROM answer_records r
         JOIN question_knowledge_points x ON x.question_id = r.question_id
        WHERE r.attempt_id = ? AND r.is_correct IS NOT NULL
        GROUP BY x.tag_id
       ON CONFLICT(user_id, course_code, tag_id) DO UPDATE SET
         correct_count = correct_count + excluded.correct_count,
         wrong_count = wrong_count + excluded.wrong_count,
         last_practiced_at = excluded.last_practiced_at`
    ).bind(attempt.user_id, attempt.course_code, attempt.attempt_id)
  );

  await db.batch(writes);
  return { objectiveScore: objective, sectionScores, pendingAi, unreviewed, auto };
}

// ---- 组卷 ----
examRouter.post('/exams/generate', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const courseCode = body.courseCode;
  const difficulty = DIFFICULTIES.includes(body.difficulty) ? body.difficulty : '随机';
  if (!courseCode) return c.json({ error: 'invalid_request', message: '缺少 courseCode' }, 400);

  const course = await c.env.DB.prepare('SELECT * FROM courses WHERE course_code = ?')
    .bind(courseCode).first();
  if (!course) return c.json({ error: 'not_found', message: '课程不存在' }, 404);

  const recentAvoid = await settingInt(c.env.DB, 'exam.recent_passage_avoid', 3);

  let plan;
  try {
    plan = await planPaper(c.env.DB, {
      courseCode, userId: me.id, difficulty, recentAvoid,
    });
  } catch (e) {
    if (e.code === 'insufficient_questions') {
      return c.json({ error: 'insufficient_questions', message: e.message }, 422);
    }
    throw e;
  }

  const attemptId = newId('att');
  const writes = [
    c.env.DB.prepare(
      `INSERT INTO attempts (attempt_id, user_id, course_code, mode, status, difficulty, time_limit_minutes)
       VALUES (?, ?, ?, 'EXAM', '进行中', ?, ?)`
    ).bind(attemptId, me.id, courseCode, difficulty, course.time_limit_minutes),
  ];

  // 题号按模板顺序重排为 1..N
  let ord = 0;
  const preview = [];
  for (const sec of plan.sections) {
    const { results: qs } = await c.env.DB.prepare(
      `SELECT question_id FROM questions
        WHERE section_id = ? AND status = '已发布' ORDER BY ord`
    ).bind(sec.sectionId).all();

    for (const q of qs) {
      ord++;
      writes.push(
        c.env.DB.prepare(
          `INSERT INTO attempt_questions
             (attempt_id, ord, question_id, section_id, section_ord, score_per_question)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(attemptId, ord, q.question_id, sec.sectionId, sec.sectionOrd, sec.scorePerQuestion)
      );
    }
    preview.push({
      sectionOrd: sec.sectionOrd,
      sectionType: sec.sectionType,
      questionCount: qs.length,
      scorePerQuestion: sec.scorePerQuestion,
      totalScore: qs.length * sec.scorePerQuestion,
    });
  }

  await c.env.DB.batch(writes);

  return c.json({
    attemptId,
    courseCode,
    difficulty,
    timeLimitMinutes: course.time_limit_minutes,
    questionCount: ord,
    totalScore: preview.reduce((n, p) => n + p.totalScore, 0),
    knowledgePointCount: plan.knowledgePointCount,
    sections: preview,
    warnings: plan.warnings,
  }, 201);
});

// ---- 取回作答（断点恢复） ----
examRouter.get('/attempts/:id', async (c) => {
  const me = c.get('user');
  const loaded = await loadAttempt(c.env.DB, c.req.param('id'), me.id);
  if (loaded.error) return c.json({ error: loaded.error }, loaded.status);

  // 时间已到但还没交，先自动交卷再返回
  if (loaded.expired) await submitAttempt(c.env.DB, loaded.attempt, { auto: true });

  const fresh = await loadAttempt(c.env.DB, c.req.param('id'), me.id);
  const submitted = fresh.attempt.status !== '进行中';
  const sections = await loadPaper(c.env.DB, fresh.attempt.attempt_id, {
    withAnswers: true, withCorrect: submitted,
  });

  return c.json({
    attempt: {
      attemptId: fresh.attempt.attempt_id,
      courseCode: fresh.attempt.course_code,
      status: fresh.attempt.status,
      difficulty: fresh.attempt.difficulty,
      timeLimitMinutes: fresh.attempt.time_limit_minutes,
      startedAt: fresh.attempt.started_at,
      submittedAt: fresh.attempt.submitted_at,
      remainingSeconds: fresh.remaining,
      autoSubmitted: loaded.expired,
    },
    sections,
  });
});

// ---- 增量保存 ----
examRouter.put('/attempts/:id/answers', async (c) => {
  const me = c.get('user');
  const loaded = await loadAttempt(c.env.DB, c.req.param('id'), me.id);
  if (loaded.error) return c.json({ error: loaded.error }, loaded.status);

  if (loaded.attempt.status !== '进行中') {
    return c.json({ error: 'already_submitted', message: '本次作答已结束，不能再修改' }, 409);
  }
  if (loaded.expired) {
    await submitAttempt(c.env.DB, loaded.attempt, { auto: true });
    return c.json({ error: 'already_submitted', message: '考试时间已到，已自动交卷' }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  const { questionId } = body;
  if (!questionId) return c.json({ error: 'invalid_request', message: '缺少 questionId' }, 400);

  const belongs = await c.env.DB.prepare(
    'SELECT 1 AS ok FROM attempt_questions WHERE attempt_id = ? AND question_id = ?'
  ).bind(loaded.attempt.attempt_id, questionId).first();
  if (!belongs) return c.json({ error: 'not_found', message: '这道题不在本卷中' }, 404);

  await c.env.DB.prepare(
    `INSERT INTO answer_records (attempt_id, question_id, user_answer, answered_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(attempt_id, question_id) DO UPDATE SET
       user_answer = excluded.user_answer, answered_at = excluded.answered_at`
  ).bind(loaded.attempt.attempt_id, questionId, body.answer ?? null).run();

  return c.json({ ok: true, remainingSeconds: loaded.remaining });
});

// ---- 交卷 ----
examRouter.post('/attempts/:id/submit', async (c) => {
  const me = c.get('user');
  const loaded = await loadAttempt(c.env.DB, c.req.param('id'), me.id);
  if (loaded.error) return c.json({ error: loaded.error }, loaded.status);
  if (loaded.attempt.status !== '进行中') {
    return c.json({ error: 'already_submitted', message: '本次作答已交卷' }, 409);
  }
  const result = await submitAttempt(c.env.DB, loaded.attempt, { auto: false });
  return c.json({ ok: true, ...result });
});

// ---- 成绩报告 ----
examRouter.get('/attempts/:id/report', async (c) => {
  const me = c.get('user');
  const loaded = await loadAttempt(c.env.DB, c.req.param('id'), me.id);
  if (loaded.error) return c.json({ error: loaded.error }, loaded.status);
  if (loaded.attempt.status === '进行中') {
    if (!loaded.expired) return c.json({ error: 'not_submitted', message: '尚未交卷' }, 409);
    await submitAttempt(c.env.DB, loaded.attempt, { auto: true });
  }

  const a = (await loadAttempt(c.env.DB, c.req.param('id'), me.id)).attempt;
  const sections = await loadPaper(c.env.DB, a.attempt_id, { withAnswers: true, withCorrect: true });

  // 与历史平均比：只看已交卷的模考
  const hist = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n, AVG(objective_score) AS avg_objective
       FROM attempts
      WHERE user_id = ? AND course_code = ? AND mode = 'EXAM' AND status = '已交卷'`
  ).bind(me.id, a.course_code).first();

  const { results: byTag } = await c.env.DB.prepare(
    `SELECT k.name,
            SUM(CASE WHEN r.is_correct = 1 THEN 1 ELSE 0 END) AS correct,
            COUNT(*) AS total
       FROM answer_records r
       JOIN question_knowledge_points x ON x.question_id = r.question_id
       JOIN knowledge_points k ON k.tag_id = x.tag_id
      WHERE r.attempt_id = ? AND r.is_correct IS NOT NULL
      GROUP BY k.name ORDER BY (correct * 1.0 / total), k.name`
  ).bind(a.attempt_id).all();

  return c.json({
    attempt: {
      attemptId: a.attempt_id,
      courseCode: a.course_code,
      difficulty: a.difficulty,
      status: a.status,
      startedAt: a.started_at,
      submittedAt: a.submitted_at,
      durationSeconds: a.duration_seconds,
      objectiveScore: a.objective_score,
      totalScore: a.total_score,
      pendingAi: a.pending_ai,
    },
    sectionScores: a.section_scores ? JSON.parse(a.section_scores) : [],
    history: { attempts: hist?.n || 0, avgObjective: hist?.avg_objective ?? null },
    knowledgePoints: byTag,
    sections,
  });
});

// ---- 历史记录 ----
examRouter.get('/history', async (c) => {
  const me = c.get('user');
  const { results } = await c.env.DB.prepare(
    `SELECT attempt_id, course_code, mode, status, difficulty, started_at, submitted_at,
            duration_seconds, objective_score, total_score, pending_ai
       FROM attempts WHERE user_id = ? ORDER BY started_at DESC LIMIT 50`
  ).bind(me.id).all();
  return c.json({ attempts: results });
});
