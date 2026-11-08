// 改进阶段 2 第一期的后台接口：改课程、组卷模板、上线清单、一键发布、学科开关、AI 花费与上限。
// 挂在 /api/admin 下（index.js），鉴权与超级管理员校验由 admin 路由组统一挂。需求见 docs/改进阶段2-PRD.md。
import { Hono } from 'hono';
import { toTemplateItem } from '../lib/template-filter.js';
import { examReadiness } from '../lib/paper.js';
import { auditStmt, audit } from '../lib/audit.js';
import { lastWriteLanded } from '../lib/write-guard.js';
import { publishExam } from './admin-bank.js';
import { budgetStatus, BUDGET_KEY } from '../lib/ai-budget.js';
import { beijingMonth } from '../lib/ai.js';
import { ANSWER_CONFIRMED } from '../lib/pickable.js';

export const adminSetupRouter = new Hono();

const bad = (c, status, error, message, extra = {}) => c.json({ error, message, ...extra }, status);
const cents = (x) => Math.round(Number(x) * 100);

async function subjectAndCourse(db, subjectId) {
  const subject = await db.prepare('SELECT * FROM subjects WHERE subject_id = ?').bind(subjectId).first();
  if (!subject) return { error: 'not_found' };
  // 一个学科一门课（拍板 2）。英语、生化也都只有一门。真有多门时按课程码取第一门，并在返回里带上全部课程。
  const { results: courses } = await db.prepare(
    'SELECT * FROM courses WHERE subject_id = ? ORDER BY course_code'
  ).bind(subjectId).all();
  if (!courses.length) return { error: 'no_course_for_subject', subject };
  return { subject, course: courses[0], courses };
}

// ---------------- 课程：改满分、时长（P1-A4） ----------------

adminSetupRouter.patch('/courses/:code', async (c) => {
  const me = c.get('user');
  const code = c.req.param('code');
  const course = await c.env.DB.prepare('SELECT * FROM courses WHERE course_code = ?').bind(code).first();
  if (!course) return bad(c, 404, 'not_found', `课程 ${code} 不存在`);
  const body = await c.req.json().catch(() => ({}));
  const next = { total_score: course.total_score, time_limit_minutes: course.time_limit_minutes };
  if (body.totalScore !== undefined) {
    const n = Number(body.totalScore);
    if (!Number.isInteger(n) || n < 1 || n > 1000) return bad(c, 400, 'invalid_total_score', '满分要是 1–1000 的整数');
    next.total_score = n;
  }
  if (body.timeLimitMinutes !== undefined) {
    const n = Number(body.timeLimitMinutes);
    if (!Number.isInteger(n) || n < 10 || n > 600) return bad(c, 400, 'invalid_time_limit', '考试时长要是 10–600 的整数（分钟）');
    next.time_limit_minutes = n;
  }
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE courses SET total_score = ?, time_limit_minutes = ? WHERE course_code = ?')
      .bind(next.total_score, next.time_limit_minutes, code),
    auditStmt(c.env.DB, {
      actorId: me.id, action: 'course.update', subjectId: course.subject_id, target: code,
      before: { totalScore: course.total_score, timeLimitMinutes: course.time_limit_minutes },
      after: { totalScore: next.total_score, timeLimitMinutes: next.time_limit_minutes },
    }),
  ]);
  const t = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n, SUM(question_count * score_per_question) AS total FROM exam_template_items WHERE course_code = ?'
  ).bind(code).first();
  const total = Math.round(Number(t?.total || 0) * 100) / 100;
  return c.json({
    course: { courseCode: code, totalScore: next.total_score, timeLimitMinutes: next.time_limit_minutes },
    // 只影响以后组的卷；模板总分对不上时页面提示去改模板
    templateMismatch: t?.n && cents(total) !== cents(next.total_score) ? { total, expected: next.total_score } : null,
  });
});

// ---------------- 组卷模板（P1-B1～B4） ----------------

async function templateView(db, subject, course) {
  const [items, types, secTypes] = await db.batch([
    db.prepare(
      `SELECT ord, label, filter, question_count, score_mode, score_per_question, pick_unit
         FROM exam_template_items WHERE course_code = ? ORDER BY ord`
    ).bind(course.course_code),
    db.prepare('SELECT type_code, name FROM subject_question_types WHERE subject_id = ? ORDER BY sort_order, type_code')
      .bind(subject.subject_id),
    db.prepare(
      `SELECT section_type, COUNT(*) AS n FROM questions WHERE course_code = ? AND retired_at IS NULL
        GROUP BY section_type ORDER BY section_type`
    ).bind(course.course_code),
  ]);
  const rows = items.results.map((r) => ({
    ord: r.ord, label: r.label, filter: JSON.parse(r.filter || '{}'), pickUnit: r.pick_unit,
    questionCount: r.question_count, scorePerQuestion: r.score_per_question,
  }));
  const total = Math.round(rows.reduce((n, r) => n + r.questionCount * r.scorePerQuestion, 0) * 100) / 100;
  const readiness = (await examReadiness(db, { courseCode: course.course_code }))[0] || null;
  return {
    subject: { subjectId: subject.subject_id, code: subject.code, name: subject.name },
    course: { courseCode: course.course_code, totalScore: course.total_score, timeLimitMinutes: course.time_limit_minutes },
    version: course.template_version,
    items: rows,
    total,
    expected: course.total_score,
    readiness,
    choices: {
      questionTypes: types.results.map((t) => ({ code: t.type_code, name: t.name })),
      sectionTypes: secTypes.results.map((s) => ({ name: s.section_type, questions: s.n })),
    },
  };
}

adminSetupRouter.get('/subjects/:id/template', async (c) => {
  const sc = await subjectAndCourse(c.env.DB, Number(c.req.param('id')));
  if (sc.error === 'not_found') return bad(c, 404, 'not_found', '学科不存在');
  if (sc.error) return bad(c, 422, sc.error, `学科「${sc.subject.name}」名下还没有课程`);
  return c.json(await templateView(c.env.DB, sc.subject, sc.course));
});

/**
 * 校验页面提交的模板。返回 { rows, problems }。问题一条一条说清楚是第几行、什么不对。
 * 每一行最后再过一遍组卷时的 toTemplateItem：两边各有一套"什么算合法"的话，迟早这里放行、组卷时抛错。
 */
function checkTemplate(items, { course, typeCodes, sectionTypes }) {
  const problems = [];
  if (!Array.isArray(items) || !items.length) return { rows: [], problems: ['模板至少要有一个部分'] };
  if (items.length > 30) problems.push(`最多 30 个部分，收到 ${items.length} 个`);
  const labels = new Set();
  const rows = items.map((it, i) => {
    const at = `第 ${i + 1} 行`;
    const label = String(it?.label ?? '').trim();
    if (!label) problems.push(`${at}没有名称`);
    else if (label.length > 20) problems.push(`${at}的名称超过 20 个字`);
    else if (labels.has(label)) problems.push(`${at}的名称「${label}」和前面重复了`);
    labels.add(label);
    const f = it?.filter && typeof it.filter === 'object' ? it.filter : {};
    const keys = Object.keys(f);
    if (keys.length !== 1 || !['questionTypes', 'sectionTypes'].includes(keys[0]) || !Array.isArray(f[keys[0]]) || !f[keys[0]].length) {
      problems.push(`${at}的"从哪类题里抽"没选（要选一种题型或一类大题）`);
    } else if (keys[0] === 'questionTypes') {
      const unknown = f.questionTypes.filter((t) => !typeCodes.has(t));
      if (unknown.length) problems.push(`${at}选的题型本学科没有：${unknown.join('、')}`);
    } else {
      const unknown = f.sectionTypes.filter((t) => !sectionTypes.has(t));
      if (unknown.length) problems.push(`${at}选的大题类别本学科的题库里没有：${unknown.join('、')}`);
    }
    const pickUnit = it?.pickUnit;
    if (pickUnit !== 'SECTION' && pickUnit !== 'QUESTION') problems.push(`${at}没选"怎么抽"`);
    if (pickUnit === 'SECTION' && keys[0] !== 'sectionTypes') problems.push(`${at}选了整篇抽，就只能按大题类别筛`);
    const count = Number(it?.questionCount);
    if (!Number.isInteger(count) || count < 1 || count > 200) problems.push(`${at}的题数要是 1–200 的整数`);
    const score = Number(it?.scorePerQuestion);
    if (!(score > 0) || !Number.isInteger(score * 2)) problems.push(`${at}的每题分值要是 0.5 的倍数且大于 0`);
    const row = {
      course_code: course.course_code, ord: i + 1, label, filter: JSON.stringify(f),
      question_count: count, score_mode: 'FROM_TEMPLATE', score_per_question: score, pick_unit: pickUnit,
    };
    if (!problems.length) {
      try { toTemplateItem(row); } catch (e) { problems.push(`${at}：${e.message}`); }
    }
    return row;
  });
  if (!problems.length) {
    const total = rows.reduce((n, r) => n + cents(r.question_count * r.score_per_question), 0);
    const expected = cents(course.total_score);
    if (total !== expected) {
      const diff = (Math.abs(total - expected) / 100).toString();
      problems.push(`各部分加起来是 ${total / 100} 分，满分是 ${course.total_score} 分，${total < expected ? '还差' : '多了'} ${diff} 分`);
    }
  }
  return { rows, problems };
}

adminSetupRouter.put('/subjects/:id/template', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const sc = await subjectAndCourse(db, Number(c.req.param('id')));
  if (sc.error === 'not_found') return bad(c, 404, 'not_found', '学科不存在');
  if (sc.error) return bad(c, 422, sc.error, `学科「${sc.subject.name}」名下还没有课程`);
  const { subject, course } = sc;
  const body = await c.req.json().catch(() => ({}));
  const version = Number(body.version);
  if (!Number.isInteger(version)) return bad(c, 400, 'version_required', '缺少模板版本号（页面加载时拿到的 version）');

  const [types, secs, before] = await db.batch([
    db.prepare('SELECT type_code FROM subject_question_types WHERE subject_id = ?').bind(subject.subject_id),
    db.prepare('SELECT DISTINCT section_type FROM questions WHERE course_code = ?').bind(course.course_code),
    db.prepare('SELECT * FROM exam_template_items WHERE course_code = ? ORDER BY ord').bind(course.course_code),
  ]);
  const { rows, problems } = checkTemplate(body.items, {
    course,
    typeCodes: new Set(types.results.map((t) => t.type_code)),
    sectionTypes: new Set(secs.results.map((s) => s.section_type)),
  });
  if (problems.length) return bad(c, 422, 'invalid_template', problems[0], { problems });

  // 写入守卫（lib/write-guard.js 的规矩）：每一句都带"版本号还是页面拿到的那个"，让它失效的那句——
  // 版本号加一——排在最后。两个人同时保存：后到的那个所有语句都不落库，回 409。
  // 不做"先读版本、比对、再写"：两个请求同时到时两边都读到旧版本，会各写一遍。
  const guard = '(SELECT template_version FROM courses WHERE course_code = ?) = ?';
  const gb = [course.course_code, version];
  const st = [
    db.prepare(`DELETE FROM exam_template_items WHERE course_code = ? AND ${guard}`).bind(course.course_code, ...gb),
  ];
  for (const r of rows) {
    st.push(db.prepare(
      `INSERT INTO exam_template_items (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
       SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${guard}`
    ).bind(r.course_code, r.ord, r.label, r.filter, r.question_count, r.score_mode, r.score_per_question, r.pick_unit, ...gb));
  }
  st.push(db.prepare(
    `INSERT INTO admin_audit (actor_id, action, subject_id, target, before_json, after_json)
     SELECT ?, 'template.update', ?, ?, ?, ? WHERE ${guard}`
  ).bind(me.id, subject.subject_id, course.course_code, JSON.stringify(before.results), JSON.stringify(rows), ...gb));
  st.push(db.prepare(
    'UPDATE courses SET template_version = template_version + 1 WHERE course_code = ? AND template_version = ?'
  ).bind(course.course_code, version));
  if (!lastWriteLanded(await db.batch(st))) {
    return bad(c, 409, 'template_changed', '模板刚被改过，请刷新后再改');
  }
  const fresh = await db.prepare('SELECT * FROM courses WHERE course_code = ?').bind(course.course_code).first();
  return c.json(await templateView(db, subject, fresh));
});

/**
 * 按一份样卷生成模板草稿（P1-B2），不落库。
 * 筛选：大题里只有一种题型、且这种题型在本学科只出现在这一类大题里 → 按题型筛（拼写单词、三种翻译）；
 * 否则按大题类别筛（选择填空、段落填空、阅读理解都是单项选择，只能靠大题类别分开）。
 * 抽法：有原文的整篇抽（题数 = 这篇的题数），没有原文的一道一道抽。分值留空，照试卷说明填。
 */
adminSetupRouter.post('/subjects/:id/template/draft', async (c) => {
  const db = c.env.DB;
  const sc = await subjectAndCourse(db, Number(c.req.param('id')));
  if (sc.error === 'not_found') return bad(c, 404, 'not_found', '学科不存在');
  if (sc.error) return bad(c, 422, sc.error, `学科「${sc.subject.name}」名下还没有课程`);
  const body = await c.req.json().catch(() => ({}));
  const exam = await db.prepare('SELECT exam_id, label, course_code FROM exams WHERE exam_id = ?').bind(String(body.examId || '')).first();
  if (!exam || exam.course_code !== sc.course.course_code) {
    return bad(c, 404, 'not_found', '这一门课里没有这个内容组');
  }
  const [secRes, qRes, spread] = await db.batch([
    db.prepare('SELECT section_id, type, ord, passage_text FROM sections WHERE exam_id = ? ORDER BY ord').bind(exam.exam_id),
    db.prepare('SELECT section_id, question_type FROM questions WHERE exam_id = ? AND retired_at IS NULL').bind(exam.exam_id),
    db.prepare(
      `SELECT question_type, COUNT(DISTINCT section_type) AS kinds, MIN(section_type) AS only_section
         FROM questions WHERE course_code = ? GROUP BY question_type`
    ).bind(sc.course.course_code),
  ]);
  const spreadBy = new Map(spread.results.map((r) => [r.question_type, r]));
  const sameType = new Map();
  for (const s of secRes.results) sameType.set(s.type, (sameType.get(s.type) || 0) + 1);
  const seen = new Map();
  const NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  const items = [];
  for (const s of secRes.results) {
    const qs = qRes.results.filter((q) => q.section_id === s.section_id);
    if (!qs.length) continue;
    const kinds = [...new Set(qs.map((q) => q.question_type))];
    const sp = kinds.length === 1 ? spreadBy.get(kinds[0]) : null;
    const byType = sp && sp.kinds === 1 && sp.only_section === s.type;
    const hasPassage = Boolean(s.passage_text && String(s.passage_text).trim());
    const k = (seen.get(s.type) || 0) + 1;
    seen.set(s.type, k);
    items.push({
      label: sameType.get(s.type) > 1 ? `${s.type}（${NUM[k - 1] || k}）` : s.type,
      filter: byType && !hasPassage ? { questionTypes: kinds } : { sectionTypes: [s.type] },
      pickUnit: hasPassage ? 'SECTION' : 'QUESTION',
      questionCount: qs.length,
      scorePerQuestion: null,
    });
  }
  return c.json({ from: { examId: exam.exam_id, label: exam.label }, items, expected: sc.course.total_score });
});

// ---------------- 上线清单（P1-L1） ----------------

async function checklistFor(db, subject) {
  const { results: courses } = await db.prepare('SELECT * FROM courses WHERE subject_id = ? ORDER BY course_code')
    .bind(subject.subject_id).all();
  const course = courses[0] || null;
  const base = {
    subject: { subjectId: subject.subject_id, code: subject.code, name: subject.name, status: subject.status,
      autoGrantNewUsers: Number(subject.auto_grant_new_users) === 1, practiceAiGrading: Number(subject.practice_ai_grading) === 1 },
    course: course ? { courseCode: course.course_code, totalScore: course.total_score, timeLimitMinutes: course.time_limit_minutes } : null,
  };
  if (!course) return { ...base, state: 'not_usable', summary: `${subject.name}：还没有课程`, items: {} };
  const cc = course.course_code;
  const [groups, pending, unpublished, published, tpl, students] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM exams WHERE course_code = ?').bind(cc),
    db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE course_code = ? AND answer_state <> ? AND retired_at IS NULL`)
      .bind(cc, ANSWER_CONFIRMED),
    // 有已确认、没停用、还是草稿的题的内容组 = 还差一步发布
    db.prepare(
      `SELECT COUNT(DISTINCT exam_id) AS n FROM questions
        WHERE course_code = ? AND answer_state = ? AND retired_at IS NULL AND status = '草稿'`
    ).bind(cc, ANSWER_CONFIRMED),
    db.prepare(`SELECT COUNT(*) AS n FROM questions WHERE course_code = ? AND status = '已发布'`).bind(cc),
    db.prepare('SELECT COUNT(*) AS n, SUM(question_count * score_per_question) AS total FROM exam_template_items WHERE course_code = ?')
      .bind(cc),
    db.prepare(
      `SELECT COUNT(*) AS n FROM user_subject_grants g JOIN users u ON u.id = g.user_id
        WHERE g.subject_id = ? AND g.status = 'ACTIVE' AND u.role = 'USER' AND u.disabled = 0
          AND (g.expires_at IS NULL OR g.expires_at > datetime('now'))`
    ).bind(subject.subject_id),
  ]);
  const n = (r) => Number(r.results[0]?.n || 0);
  const tplTotal = Math.round(Number(tpl.results[0]?.total || 0) * 100) / 100;
  const readiness = (await examReadiness(db, { courseCode: cc }))[0] || null;
  const short = (readiness?.parts || []).filter((p) => !p.ok)
    .map((p) => `${p.label}差 ${p.pickUnit === 'SECTION' ? '1 篇' : `${p.required - p.available} 题`}`);
  const items = {
    groups: n(groups),
    pendingAnswers: n(pending),
    unpublishedGroups: n(unpublished),
    publishedQuestions: n(published),
    templateItems: n(tpl),
    templateTotal: tplTotal,
    templateOk: n(tpl) > 0 && cents(tplTotal) === cents(course.total_score),
    examReady: Boolean(readiness?.ready),
    examShortages: short,
    students: n(students),
  };
  const state = !items.publishedQuestions ? 'not_usable' : (items.examReady && items.templateOk ? 'ready' : 'practice_only');
  const bits = [];
  if (!items.groups) bits.push('还没有传题');
  if (items.pendingAnswers) bits.push(`还差 ${items.pendingAnswers} 道题待确认`);
  if (items.unpublishedGroups) bits.push(`${items.unpublishedGroups} 个内容组未发布`);
  if (!items.templateItems) bits.push('还没配组卷模板');
  else if (!items.templateOk) bits.push(`组卷模板加起来 ${tplTotal} 分，和满分 ${course.total_score} 对不上`);
  else if (!items.examReady) bits.push(`模考暂时组不出卷${short.length ? `（${short.join('、')}）` : ''}`);
  bits.push(`${items.students} 名学员已开通`);
  return { ...base, state, items, summary: `${subject.name}：${bits.join(' · ')}` };
}

adminSetupRouter.get('/subjects/:id/checklist', async (c) => {
  const subject = await c.env.DB.prepare('SELECT * FROM subjects WHERE subject_id = ?').bind(Number(c.req.param('id'))).first();
  if (!subject) return bad(c, 404, 'not_found', '学科不存在');
  return c.json(await checklistFor(c.env.DB, subject));
});

// 后台首页：所有启用学科的清单
adminSetupRouter.get('/checklists', async (c) => {
  const { results } = await c.env.DB.prepare("SELECT * FROM subjects WHERE status = '启用' ORDER BY sort_order, subject_id").all();
  const out = [];
  for (const s of results) out.push(await checklistFor(c.env.DB, s));
  return c.json({ checklists: out });
});

// ---------------- 一键发布（P1-E1） ----------------

// 免费计划每次调用的子请求有上限，整卷发布一组要七八次查询，所以一次最多发 5 组，剩下的回 remaining，
// 页面接着调下一批。每一组走的都是整卷发布那同一段逻辑（admin-bank.js 的 publishExam）。
const PUBLISH_BATCH = 5;

adminSetupRouter.post('/subjects/:id/publish-all', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const sc = await subjectAndCourse(db, Number(c.req.param('id')));
  if (sc.error === 'not_found') return bad(c, 404, 'not_found', '学科不存在');
  if (sc.error) return bad(c, 422, sc.error, `学科「${sc.subject.name}」名下还没有课程`);
  const body = await c.req.json().catch(() => ({}));
  // 页面分批调用时带上前几批扣下的组，免得同一组反复被选中、永远发不完
  const skip = new Set(Array.isArray(body.skip) ? body.skip.map(String) : []);
  const { results } = await db.prepare(
    `SELECT e.exam_id, e.label FROM exams e
      WHERE e.course_code = ? AND EXISTS (
        SELECT 1 FROM questions q WHERE q.exam_id = e.exam_id AND q.answer_state = ?
           AND q.retired_at IS NULL AND q.status = '草稿')
      ORDER BY e.order_key, e.exam_id`
  ).bind(sc.course.course_code, ANSWER_CONFIRMED).all();
  const todo = results.filter((r) => !skip.has(r.exam_id));
  const batch = todo.slice(0, PUBLISH_BATCH);
  const published = [];
  const held = [];
  for (const e of batch) {
    const res = await publishExam(c, e.exam_id);
    const data = await res.json();
    if (res.status === 200) {
      published.push({ examId: e.exam_id, label: e.label, count: data.published, heldNoAnswer: data.heldNoAnswer || 0 });
    } else {
      held.push({ examId: e.exam_id, label: e.label, error: data.error, message: data.message });
    }
  }
  await audit(db, {
    actorId: me.id, action: 'subject.publish_all', subjectId: sc.subject.subject_id, target: sc.course.course_code,
    after: { published, held },
  });
  return c.json({ published, held, remaining: todo.length - batch.length });
});

// ---------------- 学科开关（P1-E2、G1） ----------------

for (const [path, col, action] of [
  ['auto-grant', 'auto_grant_new_users', 'subject.auto_grant'],
  ['practice-ai', 'practice_ai_grading', 'subject.practice_ai'],
]) {
  adminSetupRouter.put(`/subjects/:id/settings/${path}`, async (c) => {
    const me = c.get('user');
    const id = Number(c.req.param('id'));
    const subject = await c.env.DB.prepare('SELECT * FROM subjects WHERE subject_id = ?').bind(id).first();
    if (!subject) return bad(c, 404, 'not_found', '学科不存在');
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') return bad(c, 400, 'invalid_request', 'enabled 要是 true 或 false');
    const v = body.enabled ? 1 : 0;
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE subjects SET ${col} = ? WHERE subject_id = ?`).bind(v, id),
      auditStmt(c.env.DB, { actorId: me.id, action, subjectId: id, target: subject.code,
        before: { [col]: subject[col] }, after: { [col]: v } }),
    ]);
    return c.json({ subjectId: id, [col]: v });
  });
}

// ---------------- AI 花费与每月上限（P1-C2、C3） ----------------

adminSetupRouter.get('/ai/spend', async (c) => {
  const db = c.env.DB;
  const month = /^\d{4}-\d{2}$/.test(c.req.query('month') || '') ? c.req.query('month') : beijingMonth();
  // 北京月的起止换成世界时，和库里的 created_at 比
  const [y, m] = month.split('-').map(Number);
  const from = new Date(Date.UTC(y, m - 1, 1) - 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const to = new Date(Date.UTC(y, m, 1) - 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const [byFeature, bySubject] = await db.batch([
    db.prepare(
      `SELECT purpose, feature, COUNT(*) AS calls, SUM(CASE WHEN success = 1 THEN 0 ELSE 1 END) AS failed,
              SUM(cost_yuan) AS cost, SUM(CASE WHEN cost_yuan IS NULL THEN 1 ELSE 0 END) AS without_price,
              SUM(tokens_in) AS tokens_in, SUM(tokens_out) AS tokens_out
         FROM ai_usage_logs WHERE created_at >= ? AND created_at < ?
        GROUP BY purpose, feature ORDER BY cost DESC`
    ).bind(from, to),
    db.prepare(
      `SELECT l.subject_id, s.name, COUNT(*) AS calls, SUM(l.cost_yuan) AS cost
         FROM ai_usage_logs l LEFT JOIN subjects s ON s.subject_id = l.subject_id
        WHERE l.created_at >= ? AND l.created_at < ?
        GROUP BY l.subject_id ORDER BY cost DESC`
    ).bind(from, to),
  ]);
  const round = (x) => (x == null ? null : Math.round(Number(x) * 10000) / 10000);
  return c.json({
    month,
    status: month === beijingMonth() ? await budgetStatus(db) : null,
    byFeature: byFeature.results.map((r) => ({ ...r, cost: round(r.cost) })),
    bySubject: bySubject.results.map((r) => ({ ...r, cost: round(r.cost) })),
  });
});

adminSetupRouter.get('/ai/budget', async (c) => c.json(await budgetStatus(c.env.DB)));

// 改每月上限。yuan 为 null 表示不设上限（删掉那一行）。
adminSetupRouter.put('/ai/budget', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const before = await budgetStatus(db);
  let stmt;
  if (body.yuan === null) {
    stmt = db.prepare('DELETE FROM system_settings WHERE key = ?').bind(BUDGET_KEY);
  } else {
    const v = Number(body.yuan);
    if (!(v > 0) || v > 100000) return bad(c, 400, 'invalid_budget', '每月上限要是大于 0 的金额（元），不设上限传 null');
    stmt = db.prepare(
      `INSERT INTO system_settings (key, value, description) VALUES (?, ?, '每月 AI 花费上限（元）。到了只暂停错题分析，批改不停')
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).bind(BUDGET_KEY, String(Math.round(v * 100) / 100));
  }
  await db.batch([stmt, auditStmt(db, {
    actorId: me.id, action: 'ai.budget', target: BUDGET_KEY, before: { budget: before.budget }, after: { budget: body.yuan },
  })]);
  return c.json(await budgetStatus(db));
});
