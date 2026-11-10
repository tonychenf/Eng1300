// AI 拆题导入的接口（改进阶段 2 第三期，PRD 7.1）。挂在 /api/admin/import 下，只有超级管理员能用。
//
//   POST   /jobs                         建任务（选学科、起名）
//   PUT    /jobs/:id/pages/:no           传一页（浏览器压好的 JPEG data URL）→ 放进 KV 排队，D1 只记键
//   DELETE /jobs/:id/pages/:no           上传中删一页
//   POST   /jobs/:id/start               开始识别（带预估花费；本月到上限要明说继续）
//   GET    /jobs、/jobs/:id              列表、进度 + 草稿 + 可疑处
//   PATCH  /jobs/:id/questions/:qid      核对时改题（记下改了哪些字段）
//   DELETE /jobs/:id/questions/:qid      删掉一道（页眉、说明被当成了题）
//   POST   /jobs/:id/issues/resolve      可疑处点"没问题"
//   POST   /jobs/:id/pages/:no/ok        这页没问题（这一页的可疑处都算处理了）
//   PUT    /jobs/:id/pages/:no/retake    重拍：只重新识别、重新拆这一页
//   POST   /jobs/:id/resplit             拆题失败后重拆
//   POST   /jobs/:id/commit              入库（可疑处全部处理完才行）
//   POST   /jobs/:id/abandon             放弃（排队的图一并删掉）
//
// 识别和拆题不在这些请求里做：在 cron 每分钟一次的 processImportTick 里（lib/import-queue.js），关了页面也继续。
import { Hono } from 'hono';
import { budgetStatus } from '../lib/ai-budget.js';
import { auditStmt } from '../lib/audit.js';
import { planGroupImport } from '../import/group-import.js';
import { checkDraft } from '../lib/import-checks.js';
import { IMPORT_LIMITS, imageKey, subjectTypes } from '../lib/import-queue.js';

export const importJobsRouter = new Hono();

const bad = (c, status, error, message, extra = {}) => c.json({ error, message, ...extra }, status);
const BATCH = 40;
const EDITABLE = ['stem', 'options', 'no', 'questionType'];
// 入库之前（核对完）都能放弃；识别中、拆题中也能（排队的图一并删掉）
const ABANDONABLE = ['上传中', '待识别', '识别中', '拆题中', '待核对', '失败'];

async function loadJob(db, id) {
  const j = await db.prepare('SELECT * FROM import_jobs WHERE job_id = ?').bind(id).first();
  return j ? { ...j, draft: j.draft_json ? JSON.parse(j.draft_json) : null } : null;
}
async function saveDraft(db, jobId, draft, status) {
  return db.prepare(
    `UPDATE import_jobs SET draft_json = ?, updated_at = datetime('now') WHERE job_id = ? AND status = ?`
  ).bind(JSON.stringify(draft), jobId, status).run();
}
function parseImage(raw) {
  const image = String(raw ?? '');
  const m = image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return { error: '图片要是浏览器压缩好的 data:image/jpeg;base64,…' };
  if (m[2].length * 0.75 > IMPORT_LIMITS.maxImageBytes) return { error: `压缩后的图片超过 ${IMPORT_LIMITS.maxImageBytes / 1048576}MB` };
  return { image };
}
function findQuestion(draft, qid) {
  for (const [si, s] of draft.sections.entries()) {
    const qi = s.questions.findIndex((q) => q.id === qid);
    if (qi >= 0) return { s, si, qi, q: s.questions[qi] };
  }
  return null;
}

/** 可疑处（体检 + 拆题时模型自己说拿不准的），带上处理了没有。 */
export function issuesOf(job, pages, types) {
  if (!job.draft) return [];
  const typeMap = Object.fromEntries(types.map((t) => [t.code, t]));
  const pageInfo = pages.map((p) => {
    const iss = p.issues_json ? JSON.parse(p.issues_json) : {};
    return { pageNo: p.page_no, printedPage: p.printed_page, text: p.text, status: p.status, error: p.error, altDiffs: iss.altDiffs || [] };
  });
  const list = checkDraft(job.draft, pageInfo, typeMap);
  for (const [si, s] of job.draft.sections.entries()) {
    for (const q of s.questions) {
      if (q.doubt) list.push({ id: `doubt:${q.id}`, rule: 'doubt', scope: 'question', level: 'yellow', qid: q.id, sectionIdx: si, pageNo: q.pageNo, message: `第 ${q.no ?? '?'} 题：${q.doubt}` });
    }
  }
  const resolved = new Set(job.draft.resolved || []);
  const okPages = new Set(pages.filter((p) => p.reviewed).map((p) => p.page_no));
  return list.map((i) => ({
    ...i,
    // 题型不对必须改掉（入库会被拒），点"没问题"消不掉；其余的可以逐条点、也可以整页点"这页没问题"
    resolved: i.rule !== 'type' && (resolved.has(i.id) || (i.pageNo != null && okPages.has(i.pageNo))),
  }));
}

importJobsRouter.get('/jobs', async (c) => {
  const code = c.req.query('subjectCode');
  const { results } = await c.env.DB.prepare(
    `SELECT j.job_id, j.title, j.status, j.page_count, j.cost_yuan, j.exam_id, j.error, j.created_at, j.updated_at,
            s.code AS subject_code, s.name AS subject_name,
            (SELECT COUNT(*) FROM import_pages p WHERE p.job_id = j.job_id AND p.status IN ('已识别', '失败')) AS pages_done
       FROM import_jobs j JOIN subjects s ON s.subject_id = j.subject_id
      WHERE (? IS NULL OR s.code = ?) ORDER BY j.created_at DESC, j.rowid DESC LIMIT 50`
  ).bind(code ?? null, code ?? null).all();
  return c.json({ jobs: results });
});

importJobsRouter.post('/jobs', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const body = await c.req.json().catch(() => ({}));
  const subject = await db.prepare('SELECT subject_id, code, name, status FROM subjects WHERE code = ?').bind(String(body.subjectCode || '')).first();
  if (!subject) return bad(c, 404, 'subject_not_found', `没有学科 ${body.subjectCode}`);
  if (subject.status !== '启用') return bad(c, 422, 'subject_disabled', `学科「${subject.name}」已停用，不能往里导内容`);
  const title = String(body.title || '').trim().slice(0, 60)
    || `${subject.name} 导入 ${new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(5, 10)}`;
  const id = `imp-${crypto.randomUUID()}`;
  await db.batch([
    db.prepare(`INSERT INTO import_jobs (job_id, subject_id, title, status, created_by) VALUES (?, ?, ?, '上传中', ?)`)
      .bind(id, subject.subject_id, title, me.id),
    auditStmt(db, { actorId: me.id, action: 'import_job.create', subjectId: subject.subject_id, target: id, after: { title } }),
  ]);
  return c.json({ id, title, subjectCode: subject.code, status: '上传中' }, 201);
});

importJobsRouter.put('/jobs/:id/pages/:no', async (c) => {
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (job.status !== '上传中') return bad(c, 409, 'not_uploading', `任务已经${job.status}，不能再加页（某一页要换就用「这页重拍」）`);
  const no = Number(c.req.param('no'));
  if (!Number.isInteger(no) || no < 1 || no > IMPORT_LIMITS.maxPages) return bad(c, 400, 'invalid_page', `页序要在 1–${IMPORT_LIMITS.maxPages} 之间`);
  const img = parseImage((await c.req.json().catch(() => ({}))).image);
  if (img.error) return bad(c, 400, 'invalid_image', img.error);
  const old = await db.prepare('SELECT image_key FROM import_pages WHERE job_id = ? AND page_no = ?').bind(job.job_id, no).first();
  const key = imageKey(job.job_id, no, Date.now());
  await c.env.IMPORT_IMAGES.put(key, img.image, { expirationTtl: IMPORT_LIMITS.imageTtl });
  if (old?.image_key) await c.env.IMPORT_IMAGES.delete(old.image_key);
  await db.batch([
    db.prepare(
      `INSERT INTO import_pages (job_id, page_no, image_key, status) VALUES (?, ?, ?, '待识别')
       ON CONFLICT(job_id, page_no) DO UPDATE SET image_key = excluded.image_key, status = '待识别', text = NULL,
         text_alt = NULL, issues_json = NULL, attempts = 0, error = NULL, updated_at = datetime('now')`
    ).bind(job.job_id, no, key),
    db.prepare(`UPDATE import_jobs SET page_count = (SELECT COUNT(*) FROM import_pages WHERE job_id = ?), updated_at = datetime('now') WHERE job_id = ?`)
      .bind(job.job_id, job.job_id),
  ]);
  return c.json({ ok: true, pageNo: no });
});

importJobsRouter.delete('/jobs/:id/pages/:no', async (c) => {
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (job.status !== '上传中') return bad(c, 409, 'not_uploading', `任务已经${job.status}，不能删页`);
  const no = Number(c.req.param('no'));
  const row = await db.prepare('SELECT image_key FROM import_pages WHERE job_id = ? AND page_no = ?').bind(job.job_id, no).first();
  if (!row) return bad(c, 404, 'page_not_found', `没有第 ${no} 页`);
  if (row.image_key) await c.env.IMPORT_IMAGES.delete(row.image_key);
  await db.batch([
    db.prepare('DELETE FROM import_pages WHERE job_id = ? AND page_no = ?').bind(job.job_id, no),
    db.prepare(`UPDATE import_jobs SET page_count = (SELECT COUNT(*) FROM import_pages WHERE job_id = ?) WHERE job_id = ?`).bind(job.job_id, job.job_id),
  ]);
  return c.json({ ok: true });
});

importJobsRouter.post('/jobs/:id/start', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (job.status !== '上传中') return bad(c, 409, 'not_uploading', `任务已经${job.status}`);
  const { results: pages } = await db.prepare('SELECT page_no FROM import_pages WHERE job_id = ? ORDER BY page_no').bind(job.job_id).all();
  if (!pages.length) return bad(c, 422, 'no_pages', '还没传照片');
  // 页序要连着（1、2、3…）：中间缺一页，是上传半路断了，不是"本来就没有"
  const gap = pages.findIndex((p, i) => p.page_no !== i + 1);
  if (gap >= 0) return bad(c, 422, 'page_gap', `第 ${gap + 1} 张照片没传上来，请重新传`);
  const body = await c.req.json().catch(() => ({}));
  const budget = await budgetStatus(db);
  if (budget.over && body.confirmOverBudget !== true) {
    return bad(c, 409, 'over_budget', `本月 AI 花费已到上限（已花 ${budget.spent} 元 / 上限 ${budget.budget} 元），确认继续才会开始识别`, { budget });
  }
  const est = Number.isFinite(Number(body.estimateYuan)) ? Number(body.estimateYuan) : null;
  const r = await db.batch([
    db.prepare(`UPDATE import_jobs SET status = '待识别', est_cost_yuan = ?, page_count = ?, updated_at = datetime('now') WHERE job_id = ? AND status = '上传中'`)
      .bind(est, pages.length, job.job_id),
    auditStmt(db, { actorId: me.id, action: budget.over ? 'import_job.start_over_budget' : 'import_job.start', subjectId: job.subject_id, target: job.job_id, after: { pages: pages.length, estimateYuan: est } }),
  ]);
  if (!r[0].meta.changes) return bad(c, 409, 'not_uploading', '任务的状态刚变过，刷新再看');
  return c.json({ ok: true, status: '待识别', pages: pages.length });
});

importJobsRouter.get('/jobs/:id', async (c) => {
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  const subject = await db.prepare('SELECT code, name FROM subjects WHERE subject_id = ?').bind(job.subject_id).first();
  const { results: pages } = await db.prepare(
    `SELECT page_no, printed_page, status, text, text_alt, issues_json, reviewed, attempts, cost_yuan, error,
            image_key IS NOT NULL AS has_image FROM import_pages WHERE job_id = ? ORDER BY page_no`
  ).bind(job.job_id).all();
  const types = await subjectTypes(db, job.subject_id);
  const issues = issuesOf(job, pages, types);
  const count = (st) => pages.filter((p) => p.status === st).length;
  return c.json({
    job: {
      id: job.job_id, title: job.title, status: job.status, pageCount: job.page_count, estCostYuan: job.est_cost_yuan,
      costYuan: job.cost_yuan, examId: job.exam_id, error: job.error, createdAt: job.created_at, updatedAt: job.updated_at,
      subjectCode: subject?.code, subjectName: subject?.name,
    },
    progress: { total: pages.length, recognized: count('已识别'), failed: count('失败'), queued: count('待识别') + count('识别中') },
    pages: pages.map((p) => ({
      pageNo: p.page_no, printedPage: p.printed_page, status: p.status, text: p.text, textAlt: p.text_alt,
      reviewed: Boolean(p.reviewed), attempts: p.attempts, cost: p.cost_yuan, error: p.error, hasImage: Boolean(p.has_image),
      quick: p.issues_json ? JSON.parse(p.issues_json).quick || [] : [],
    })),
    draft: job.draft ? { sections: job.draft.sections, edited: job.draft.edited || {} } : null,
    types,
    issues,
    pendingIssues: issues.filter((i) => !i.resolved).length,
  });
});

importJobsRouter.patch('/jobs/:id/questions/:qid', async (c) => {
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (job.status !== '待核对' || !job.draft) return bad(c, 409, 'not_reviewing', `任务${job.status}，现在不能改题`);
  const hit = findQuestion(job.draft, c.req.param('qid'));
  if (!hit) return bad(c, 404, 'question_not_found', '草稿里没有这道题');
  const body = await c.req.json().catch(() => ({}));
  const types = await subjectTypes(db, job.subject_id);
  const changed = [];
  for (const k of EDITABLE) {
    if (body[k] === undefined) continue;
    let v = body[k];
    if (k === 'stem') v = String(v ?? '');
    if (k === 'options') {
      if (v !== null && (!Array.isArray(v) || v.some((o) => typeof o !== 'string'))) return bad(c, 400, 'invalid_options', 'options 要是字符串数组或 null');
      v = v && v.length ? v.map((o) => o.trim()).filter(Boolean) : null;
    }
    if (k === 'no') {
      if (v !== null && !Number.isInteger(Number(v))) return bad(c, 400, 'invalid_no', '题号要是整数');
      v = v === null ? null : Number(v);
    }
    if (k === 'questionType' && !types.some((t) => t.code === v)) return bad(c, 400, 'invalid_type', `这门课没有题型 ${v}`);
    if (JSON.stringify(hit.q[k]) !== JSON.stringify(v)) { hit.q[k] = v; changed.push(k); }
  }
  if (changed.length) {
    const ed = job.draft.edited || (job.draft.edited = {});
    ed[hit.q.id] = [...new Set([...(ed[hit.q.id] || []), ...changed])];
    const r = await saveDraft(db, job.job_id, job.draft, '待核对');
    if (!r.meta.changes) return bad(c, 409, 'not_reviewing', '任务的状态刚变过，刷新再看');
  }
  return c.json({ ok: true, question: hit.q, changed });
});

importJobsRouter.delete('/jobs/:id/questions/:qid', async (c) => {
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (job.status !== '待核对' || !job.draft) return bad(c, 409, 'not_reviewing', `任务${job.status}，现在不能改题`);
  const hit = findQuestion(job.draft, c.req.param('qid'));
  if (!hit) return bad(c, 404, 'question_not_found', '草稿里没有这道题');
  hit.s.questions.splice(hit.qi, 1);
  job.draft.sections = job.draft.sections.filter((s) => s.questions.length);
  await saveDraft(db, job.job_id, job.draft, '待核对');
  return c.json({ ok: true });
});

importJobsRouter.post('/jobs/:id/issues/resolve', async (c) => {
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (job.status !== '待核对' || !job.draft) return bad(c, 409, 'not_reviewing', `任务${job.status}`);
  const body = await c.req.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids : [];
  if (!ids.length) return bad(c, 400, 'invalid_request', '要给出可疑处的 id');
  job.draft.resolved = [...new Set([...(job.draft.resolved || []), ...ids.map(String)])];
  await saveDraft(db, job.job_id, job.draft, '待核对');
  return c.json({ ok: true, resolved: job.draft.resolved.length });
});

importJobsRouter.post('/jobs/:id/pages/:no/ok', async (c) => {
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (job.status !== '待核对') return bad(c, 409, 'not_reviewing', `任务${job.status}`);
  const r = await db.prepare('UPDATE import_pages SET reviewed = 1 WHERE job_id = ? AND page_no = ?').bind(job.job_id, Number(c.req.param('no'))).run();
  if (!r.meta.changes) return bad(c, 404, 'page_not_found', '没有这一页');
  return c.json({ ok: true });
});

importJobsRouter.put('/jobs/:id/pages/:no/retake', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (!['待核对', '失败'].includes(job.status) || !job.draft) return bad(c, 409, 'not_reviewing', `任务${job.status}，现在不能重拍`);
  const no = Number(c.req.param('no'));
  const page = await db.prepare('SELECT page_no FROM import_pages WHERE job_id = ? AND page_no = ?').bind(job.job_id, no).first();
  if (!page) return bad(c, 404, 'page_not_found', `没有第 ${no} 页`);
  const img = parseImage((await c.req.json().catch(() => ({}))).image);
  if (img.error) return bad(c, 400, 'invalid_image', img.error);
  // 这一页上改过的题会被新识别的结果换掉：回给页面说清楚覆盖了几处
  const edited = job.draft.sections.flatMap((s) => s.questions).filter((q) => q.pageNo === no && (job.draft.edited || {})[q.id]).length;
  const key = imageKey(job.job_id, no, Date.now());
  await c.env.IMPORT_IMAGES.put(key, img.image, { expirationTtl: IMPORT_LIMITS.imageTtl });
  job.draft.resplitPages = [...new Set([...(job.draft.resplitPages || []), no])];
  const r = await db.batch([
    db.prepare(`UPDATE import_jobs SET status = '识别中', draft_json = ?, error = NULL, updated_at = datetime('now') WHERE job_id = ? AND status = ?`)
      .bind(JSON.stringify(job.draft), job.job_id, job.status),
    db.prepare(`UPDATE import_pages SET image_key = ?, status = '待识别', reviewed = 0, attempts = 0, error = NULL, text = NULL, text_alt = NULL,
                       issues_json = NULL, updated_at = datetime('now') WHERE job_id = ? AND page_no = ?`).bind(key, job.job_id, no),
    auditStmt(db, { actorId: me.id, action: 'import_job.retake', subjectId: job.subject_id, target: `${job.job_id}#${no}`, after: { overwrittenEdits: edited } }),
  ]);
  if (!r[0].meta.changes) {
    await c.env.IMPORT_IMAGES.delete(key);
    return bad(c, 409, 'not_reviewing', '任务的状态刚变过，刷新再看');
  }
  return c.json({ ok: true, overwrittenEdits: edited });
});

importJobsRouter.post('/jobs/:id/resplit', async (c) => {
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (job.status !== '失败') return bad(c, 409, 'not_failed', `任务${job.status}，不用重拆`);
  await db.prepare(`UPDATE import_jobs SET status = '识别中', error = NULL, updated_at = datetime('now') WHERE job_id = ? AND status = '失败'`).bind(job.job_id).run();
  return c.json({ ok: true, status: '识别中' });
});

/** 草稿拼成题库文件（data/subjects 下 groups 目录里那种），交给 planGroupImport：编号、校验、考点、整组删除都和题库文件导入一套。 */
export function draftToGroupFile(job, types) {
  const typeMap = Object.fromEntries(types.map((t) => [t.code, t]));
  return {
    groupId: 'ai-import',   // 只给文件校验用：入库时 planGroupImport 按本次导入重新编号
    label: job.title,
    answerState: '缺答案',
    sections: job.draft.sections.filter((s) => s.questions.length).map((s, si) => ({
      type: s.type,
      order: si + 1,
      passageTitle: s.title || null,
      passageText: s.passage || null,
      questions: s.questions.map((q, qi) => {
        const t = typeMap[q.questionType] || {};
        // 选择题答案落在 answer 上；按采分点批的题由出答案那一步拆采分点；其余（拼写、填空）给一个空让出答案那一步填
        const items = t.widget === 'choice' || t.strategy === 'AI_SCORE_POINTS' ? [] : [{ ord: 1, kind: 'BLANK' }];
        return {
          order: Number.isInteger(q.no) ? q.no : qi + 1,
          questionType: q.questionType,
          stem: q.stem || '',
          options: q.options && q.options.length ? q.options : null,
          ...(items.length ? { items } : {}),
        };
      }),
    })),
  };
}

importJobsRouter.post('/jobs/:id/commit', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (job.status !== '待核对' || !job.draft) return bad(c, 409, 'not_reviewing', `任务${job.status}，不能入库`);
  const { results: pages } = await db.prepare('SELECT * FROM import_pages WHERE job_id = ? ORDER BY page_no').bind(job.job_id).all();
  const types = await subjectTypes(db, job.subject_id);
  const pending = issuesOf(job, pages, types).filter((i) => !i.resolved);
  if (pending.length) return bad(c, 409, 'issues_pending', `还有 ${pending.length} 处可疑没处理（改了或点"没问题"才算）`, { pending: pending.slice(0, 20) });
  const all = job.draft.sections.flatMap((s) => s.questions);
  if (!all.length) return bad(c, 422, 'no_questions', '一道题都没有，入不了库');

  const subject = await db.prepare('SELECT * FROM subjects WHERE subject_id = ?').bind(job.subject_id).first();
  const course = await db.prepare('SELECT course_code FROM courses WHERE subject_id = ? ORDER BY course_code LIMIT 1').bind(job.subject_id).first();
  if (!course) return bad(c, 422, 'no_course_for_subject', `学科「${subject.name}」名下还没有课程`);
  const day = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `${subject.code}-imp${day}-`;
  const { results: taken } = await db.prepare('SELECT exam_id FROM exams WHERE substr(exam_id, 1, ?) = ?').bind(prefix.length, prefix).all();
  let n = 1;
  while (taken.some((r) => r.exam_id === `${prefix}${n}`)) n++;
  const groupId = `${prefix}${n}`;
  const top = await db.prepare(
    'SELECT MAX(e.order_key) AS m FROM exams e JOIN courses co ON co.course_code = e.course_code WHERE co.subject_id = ?'
  ).bind(job.subject_id).first();
  const fileJson = draftToGroupFile(job, types);
  let plan;
  try {
    plan = await planGroupImport(db, {
      subject, courseCode: course.course_code, bytes: new TextEncoder().encode(JSON.stringify(fileJson)).buffer,
      groupId, label: job.title, orderKey: Number(top?.m || 0) + 10, filename: `${job.title}（AI 拆题导入）`,
      uploadedBy: me?.username || `user:${me?.id ?? '?'}`,
    });
  } catch (e) {
    return bad(c, 422, e.code || 'commit_failed', e.message || String(e));
  }
  // 出自第几页、改过哪些字段：planGroupImport 按出现顺序编号 q001、q002…，这里按同样的顺序对回去
  const printedOf = new Map(pages.map((p) => [p.page_no, p.printed_page]));
  let k = 0;
  const extra = [];
  for (const s of job.draft.sections.filter((x) => x.questions.length)) {
    for (const q of s.questions) {
      k++;
      const qidDb = `${groupId}-q${String(k).padStart(3, '0')}`;
      const edited = (job.draft.edited || {})[q.id];
      extra.push(db.prepare('UPDATE questions SET source_page = ?, edited_fields = ? WHERE question_id = ?')
        .bind(printedOf.get(q.pageNo) ?? null, edited?.length ? JSON.stringify(edited) : null, qidDb));
    }
  }
  const st = [...plan.statements, ...extra,
    auditStmt(db, { actorId: me.id, action: 'import_job.commit', subjectId: job.subject_id, target: job.job_id, after: { examId: groupId, questions: k } })];
  for (let i = 0; i < st.length; i += BATCH) await db.batch(st.slice(i, i + BATCH));
  // 状态最后改：前面任何一批失败，任务还停在「待核对」，可以再点入库（已写进去的那一章要先在校对页删掉，编号会自动往后挪）
  await db.prepare(`UPDATE import_jobs SET status = '已入库', exam_id = ?, updated_at = datetime('now') WHERE job_id = ? AND status = '待核对'`)
    .bind(groupId, job.job_id).run();
  return c.json({ ok: true, examId: groupId, questions: k, summary: plan.summary });
});

importJobsRouter.post('/jobs/:id/abandon', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const job = await loadJob(db, c.req.param('id'));
  if (!job) return bad(c, 404, 'not_found', '没有这个导入任务');
  if (!ABANDONABLE.includes(job.status)) return bad(c, 409, 'cannot_abandon', `任务${job.status}，不能放弃`);
  const { results } = await db.prepare('SELECT image_key FROM import_pages WHERE job_id = ? AND image_key IS NOT NULL').bind(job.job_id).all();
  for (const r of results) await c.env.IMPORT_IMAGES.delete(r.image_key);
  await db.batch([
    db.prepare(`UPDATE import_jobs SET status = '已放弃', updated_at = datetime('now') WHERE job_id = ?`).bind(job.job_id),
    db.prepare(`UPDATE import_pages SET image_key = NULL, status = CASE WHEN status IN ('待识别', '识别中') THEN '失败' ELSE status END WHERE job_id = ?`).bind(job.job_id),
    auditStmt(db, { actorId: me.id, action: 'import_job.abandon', subjectId: job.subject_id, target: job.job_id }),
  ]);
  return c.json({ ok: true, status: '已放弃', imagesDeleted: results.length });
});
