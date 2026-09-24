import { Hono } from 'hono';
import { planPaper } from '../lib/paper.js';
import { gradeQuestion } from '../lib/grade.js';
import { loadItemRows } from '../lib/question-items.js';
import { loadAssetRows } from '../lib/stem-assets.js';
import { loadPackByCourse, settingInt as packSettingInt } from '../lib/subject-pack.js';
import { requireAuth } from '../lib/auth.js';
import { requireCourseAccess, requireAttemptAccess, accessibleCourseFilter } from '../lib/access.js';
import { masteryWrites } from '../lib/mastery.js';
import { wrongbookWrites } from '../lib/wrongbook.js';

export const examRouter = new Hono();

// 按具体前缀挂鉴权，不用 '*'：这个路由挂在 /api 下，
// 用 '*' 会把 /api/health 和 /api/auth/login 一起挡住。
examRouter.use('/exams/*', requireAuth);
examRouter.use('/attempts/*', requireAuth);
examRouter.use('/history', requireAuth);

// 学科访问控制挂在鉴权之后、handler 之前（N2，见 lib/access.js 顶部注释）。
// 挂成中间件而不是在每个 handler 里调，是为了让"漏掉校验"变成做不到的事。
// /history 是跨学科聚合，不能用 403，改为在查询里过滤行——见下面那条 SQL。
examRouter.use('/exams/*', requireCourseAccess);
examRouter.use('/attempts/*', requireAttemptAccess);

const DIFFICULTIES = ['随机', '简单', '正常', '困难'];

function newId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

// 参数取值改走能力包（学科覆盖 → 全局默认 → 抛错）。蓝本那个带兜底常量的版本删掉了：
// 兜底常量恰好等于种子里的值，"表是空的"会被伪装成"配置就是这样"。

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
            r.user_answer, r.is_correct, r.score, r.ai_judged, r.ai_comment,
            r.score_rate, r.item_results
       FROM attempt_questions aq
       JOIN questions q ON q.question_id = aq.question_id
       JOIN sections s ON s.section_id = aq.section_id
       LEFT JOIN answer_records r ON r.attempt_id = aq.attempt_id AND r.question_id = aq.question_id
      WHERE aq.attempt_id = ?
      ORDER BY aq.ord`
  ).bind(attemptId).all();

  // 多单元题要一空一个输入框，所以整卷的得分单元一次读好带给前端。
  // 没有得分单元的题这里拿到空数组，前端照旧渲染一个输入框。
  const itemRows = await loadItemRows(db, results.map((r) => r.question_id));
  // 题干里的图（§6.4.6）。path 自带学科码，前端直接拼 /bank/<path> 取静态资源。
  const assetRows = await loadAssetRows(db, results.map((r) => r.question_id));

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
      // 题干里的 ![key] 要换成图，所以把资源一并带过去。alt 也要给：
      // 它要落到 <img alt> 上（G1），读屏和图裂时都靠它。
      assets: assetRows.get(row.question_id) || [],
      // 作答控件要知道这道题有几个空、每个空是什么形态。标准答案不在这里给——
      // 那是判分完之后（withCorrect）才能看的东西。
      items: (itemRows.get(row.question_id) || []).map((it) => ({
        ord: it.item_ord, kind: it.item_kind, weight: it.weight,
        groupKey: it.group_key ?? null,
      })),
    };
    if (withAnswers) q.userAnswer = row.user_answer ?? null;
    if (withCorrect) {
      q.correctAnswer = row.correct_answer;
      q.explanation = row.answer_explanation;
      q.isCorrect = row.is_correct;
      q.score = row.score;
      q.scoreRate = row.score_rate;
      q.itemResults = row.item_results ? JSON.parse(row.item_results) : null;
      // 逐项的标准答案只在报告里给
      for (const it of q.items) {
        const src = (itemRows.get(row.question_id) || []).find((x) => x.item_ord === it.ord);
        it.answer = src ? src.answer : null;
      }
      q.aiJudged = Boolean(row.ai_judged);
      q.aiComment = row.ai_comment;
    }
    sec.questions.push(q);
  }
  return sections;
}

// 判分并落库。已交卷的直接返回，不重复判。
async function submitAttempt(db, attempt, { auto = false }) {
  // 能力包一次读好往下传：这一段要对整卷逐题判分，每题读一次库就是 51 次往返。
  const pack = await loadPackByCourse(db, attempt.course_code);
  const { results: rows } = await db.prepare(
    `SELECT aq.ord, aq.section_ord, aq.score_per_question, q.question_id, q.question_type, q.answer,
            s.type AS section_type, r.user_answer
       FROM attempt_questions aq
       JOIN questions q ON q.question_id = aq.question_id
       JOIN sections s ON s.section_id = aq.section_id
       LEFT JOIN answer_records r ON r.attempt_id = aq.attempt_id AND r.question_id = aq.question_id
      WHERE aq.attempt_id = ? ORDER BY aq.ord`
  ).bind(attempt.attempt_id).all();

  // 得分单元一次读好：一题多空、采分点都在这张表里，逐题读就是 51 次往返。
  const itemRows = await loadItemRows(db, rows.map((r) => r.question_id));

  const bySection = new Map();
  const writes = [];
  const graded = new Map();
  let objective = 0;
  let pendingAi = 0;
  let pendingManual = 0;
  let unreviewed = 0;

  for (const row of rows) {
    // 判一次，后面掌握度、错题本都复用这一次的结果。原来这三处各调一次，
    // 同一道题判三遍——多空题以后还要带着得分单元判，那就是三倍的活。
    const g = gradeQuestion(pack, row, row.user_answer, row.score_per_question,
      { items: itemRows.get(row.question_id) || [] });
    graded.set(row.question_id, g);
    if (g.score !== null) objective += g.score;
    // 蓝本这里写死 === 'essay'。改读题型声明：哪些题型要 AI 判分由学科自己说了算，
    // 生化的名词解释和问答都要 AI，而它们不叫 essay。
    if (pack.typeOf(row.question_type).needsAi) pendingAi++;
    else if (g.pendingManual) pendingManual++;
    else if (g.needsAiReview) unreviewed++;

    writes.push(
      db.prepare(
        `INSERT INTO answer_records
           (attempt_id, question_id, user_answer, is_correct, score, score_rate, item_results, answered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(attempt_id, question_id) DO UPDATE SET
           is_correct = excluded.is_correct, score = excluded.score,
           score_rate = excluded.score_rate, item_results = excluded.item_results`
      ).bind(attempt.attempt_id, row.question_id, row.user_answer ?? null, g.isCorrect, g.score,
             g.scoreRate, g.itemResults ? JSON.stringify(g.itemResults) : null)
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
              objective_score = ?, total_score = ?, section_scores = ?, pending_ai = ?,
              pending_manual = ?
        WHERE attempt_id = ? AND status = '进行中'`
    ).bind(objective, objective, JSON.stringify(sectionScores), pendingAi, pendingManual,
           attempt.attempt_id)
  );

  // 掌握度与练习共用一套推进逻辑：按题号顺序逐题推进，连对次数才算得准。
  // 原来那条聚合 SQL 只累计对错次数，连对次数一直留 0，M4 的加权抽题要用它。
  const ruleGraded = rows.filter((r) => !pack.typeOf(r.question_type).needsAi);
  if (ruleGraded.length) {
    const holes = ruleGraded.map(() => '?').join(',');
    const { results: tagRows } = await db.prepare(
      `SELECT question_id, tag_id FROM question_knowledge_points
        WHERE question_id IN (${holes})`
    ).bind(...ruleGraded.map((r) => r.question_id)).all();
    const byQuestion = new Map();
    for (const t of tagRows) {
      if (!byQuestion.has(t.question_id)) byQuestion.set(t.question_id, []);
      byQuestion.get(t.question_id).push(t.tag_id);
    }
    const entries = ruleGraded
      .map((r) => ({
        tagIds: byQuestion.get(r.question_id) || [],
        isCorrect: graded.get(r.question_id).isCorrect,
      }))
      .filter((e) => e.tagIds.length && e.isCorrect !== null);
    writes.push(...(await masteryWrites(db, attempt.user_id, attempt.course_code, entries)));

    // 错题本：判分时就落库，不等 AI（PRD §10.3 的主链路不依赖 AI）
    const wbEntries = ruleGraded
      .filter((r) => graded.get(r.question_id).isCorrect !== null)
      .map((r) => ({ questionId: r.question_id, isCorrect: graded.get(r.question_id).isCorrect }));
    writes.push(...(await wrongbookWrites(db, attempt.user_id, attempt.course_code, wbEntries, {
      attemptId: attempt.attempt_id, source: 'EXAM',
    })));
  }

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

  const examPack = await loadPackByCourse(c.env.DB, courseCode);
  const recentAvoid = await packSettingInt(c.env.DB, examPack.subjectId, 'exam.recent_passage_avoid');

  let plan;
  try {
    plan = await planPaper(c.env.DB, {
      courseCode, userId: me.id, difficulty, recentAvoid,
    });
  } catch (e) {
    // 题库不够、模板配错，都是"这套卷组不出来"而不是"服务器坏了"。
    // 让它们各自带着错误码回 422：500 只会给管理员一句"服务器错误"，
    // 而这几种情况恰恰是他自己在后台改一下就能解决的。
    if (['insufficient_questions', 'unsupported_filter', 'bad_filter',
      'bad_template', 'score_mode_not_implemented'].includes(e.code)) {
      return c.json({ error: e.code, message: e.message }, 422);
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

  // 题号按模板顺序重排为 1..N。
  //
  // **卷面总分从这些行现加**（§6.4.7），不再算"题数 × 每题分"：分值归属定成
  // "题目给相对权重、模板给绝对分"之后，一道题在本卷值多少分只由 attempt_questions
  // 那一行说了算。乘法在同一部分每题同分时碰巧也对，但 FROM_QUESTION 一开口子就错，
  // 而错了不会报错——卷面总分和逐题分值加起来对不上，谁也不会去核。
  let ord = 0;
  const rows = [];
  const preview = [];
  for (const part of plan.parts) {
    const from = rows.length;
    for (const q of part.questions) {
      ord++;
      rows.push({
        ord, questionId: q.questionId, sectionId: q.sectionId,
        sectionOrd: part.ord, score: part.scorePerQuestion,
      });
    }
    const mine = rows.slice(from);
    preview.push({
      sectionOrd: part.ord,
      sectionType: part.label,
      questionCount: mine.length,
      scorePerQuestion: part.scorePerQuestion,
      totalScore: mine.reduce((n, r) => n + r.score, 0),
    });
  }
  for (const r of rows) {
    writes.push(
      c.env.DB.prepare(
        `INSERT INTO attempt_questions
           (attempt_id, ord, question_id, section_id, section_ord, score_per_question)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(attemptId, r.ord, r.questionId, r.sectionId, r.sectionOrd, r.score)
    );
  }

  await c.env.DB.batch(writes);

  return c.json({
    attemptId,
    courseCode,
    difficulty,
    timeLimitMinutes: course.time_limit_minutes,
    questionCount: ord,
    totalScore: Math.round(rows.reduce((n, r) => n + r.score, 0) * 100) / 100,
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
  // 跨学科聚合：只能过滤行，不能整个接口 403。
  // 少了这层过滤，学科授权被撤销之后，历史记录里那几次模考照样列出来。
  const acc = accessibleCourseFilter(me, 'attempts');
  const { results } = await c.env.DB.prepare(
    `SELECT attempt_id, course_code, mode, status, difficulty, started_at, submitted_at,
            duration_seconds, objective_score, total_score, pending_ai
       FROM attempts WHERE user_id = ? AND ${acc.sql} ORDER BY started_at DESC LIMIT 50`
  ).bind(me.id, ...acc.binds).all();
  return c.json({ attempts: results });
});
