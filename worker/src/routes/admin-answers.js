// 批量核对答案（改进阶段 2 第三期 D，PRD 7.2）。挂在 /api/admin/bank 下：
//
//   GET  /exams/:examId/answer-queue   要核的题按疑点排好：题面有问题 → 和书上手写 / 原书答案页不一致 → AI 拿不准 → 其余
//   POST /exams/:examId/confirm-rest   "其余没有疑点的"整组确认：逐题跑标准答案自检，过的确认、不过的留下并说原因
//   POST /exams/:examId/answer-page    传一张原书答案页：识别出"题号 → 答案"，和 AI 答案逐题比，一致的确认、不一致的排最前
//   GET  /exams/:examId/checklist      核对单（Markdown）：拿不准的排前
//
// 一题一题的"对 / 改"不在这里：沿用校对页那个保存接口（PATCH /bank/questions/:id，带标准答案自检和确认留痕），
// 不另写一套"什么算确认"。
import { Hono } from 'hono';
import { answerKeyProblems } from '../lib/answer-check.js';
import { answerKey } from '../lib/answer-key.js';
import { loadPackByCourse } from '../lib/subject-pack.js';
import { chat, costOf, resolveSettings } from '../lib/ai.js';
import { auditStmt } from '../lib/audit.js';
import { ANSWER_CONFIRMED } from '../lib/pickable.js';

export const answersRouter = new Hono();
const bad = (c, status, error, message, extra = {}) => c.json({ error, message, ...extra }, status);
const BATCH = 40;

// 两个答案算不算一样：选择题比字母，其余去掉空白、全半角、大小写、句末标点再比
export function sameAnswer(a, b) {
  const n = (x) => String(x ?? '').normalize('NFKC').replace(/\s+/g, '').replace(/[.。;；,，]+$/, '').toLowerCase();
  return n(a) !== '' && n(a) === n(b);
}

/** 一道题现在的答案（给人看、拿去和书上比）：单答案题是 answer，多空题拼各空。 */
function currentAnswer(q, items) {
  if (q.answer != null && String(q.answer).trim()) return String(q.answer).trim();
  const inputs = items.filter((r) => r.item_kind === 'BLANK' || r.item_kind === 'OPTION').map((r) => r.answer).filter(Boolean);
  return inputs.length ? inputs.join(' / ') : null;
}

async function loadExam(db, examId) {
  const exam = await db.prepare('SELECT exam_id, label, course_code FROM exams WHERE exam_id = ?').bind(examId).first();
  if (!exam) return null;
  const { results: qs } = await db.prepare(
    `SELECT q.question_id, q.ord, q.section_type, q.question_type, q.stem, q.options, q.answer, q.answer_explanation,
            q.answer_state, q.answer_source, q.source_page, q.retired_at,
            f.confidence, f.stem_problem, f.handwritten, f.book_answer
       FROM questions q LEFT JOIN answer_review_flags f ON f.question_id = q.question_id
      WHERE q.exam_id = ? ORDER BY q.section_id, q.ord, q.question_id`
  ).bind(examId).all();
  const { results: items } = await db.prepare(
    'SELECT * FROM question_items WHERE question_id IN (SELECT question_id FROM questions WHERE exam_id = ?) ORDER BY question_id, item_ord'
  ).bind(examId).all();
  const itemsBy = new Map();
  for (const r of items) { if (!itemsBy.has(r.question_id)) itemsBy.set(r.question_id, []); itemsBy.get(r.question_id).push(r); }
  return { exam, qs: qs.filter((q) => !q.retired_at), itemsBy };
}

/** 一道题的疑点和排位（越小越靠前）。 */
export function reviewRank(q, cur) {
  const reasons = [];
  if (q.stem_problem) reasons.push({ kind: 'stem', text: `做题时发现题面有问题：${q.stem_problem}` });
  if (q.book_answer && cur && !sameAnswer(q.book_answer, cur)) reasons.push({ kind: 'book', text: `原书答案页是「${q.book_answer}」，AI 答的是「${cur}」` });
  if (q.handwritten && cur && !sameAnswer(q.handwritten, cur)) reasons.push({ kind: 'hand', text: `书上手写的是「${q.handwritten}」，AI 答的是「${cur}」` });
  if (q.confidence === '低' || q.confidence === '中') reasons.push({ kind: 'unsure', text: `AI 自己说拿不准（把握：${q.confidence}）` });
  if (!cur && q.answer_state !== ANSWER_CONFIRMED) reasons.push({ kind: 'missing', text: '还没有答案' });
  const rank = reasons.some((r) => r.kind === 'stem') ? 0
    : reasons.some((r) => r.kind === 'book' || r.kind === 'hand') ? 1
      : reasons.some((r) => r.kind === 'unsure' || r.kind === 'missing') ? 2 : 3;
  return { rank, reasons };
}

function shapeQuestion(q, items, rk) {
  return {
    questionId: q.question_id, ord: q.ord, sectionType: q.section_type, questionType: q.question_type,
    stem: q.stem, options: q.options ? JSON.parse(q.options) : null, answer: currentAnswer(q, items),
    answerKey: answerKey(q, items), explanation: q.answer_explanation, answerState: q.answer_state, answerSource: q.answer_source,
    sourcePage: q.source_page, handwritten: q.handwritten, bookAnswer: q.book_answer, confidence: q.confidence,
    items: items.map((r) => ({ ord: r.item_ord, kind: r.item_kind, answer: r.answer })), rank: rk.rank, reasons: rk.reasons,
  };
}

answersRouter.get('/exams/:examId/answer-queue', async (c) => {
  const data = await loadExam(c.env.DB, c.req.param('examId'));
  if (!data) return bad(c, 404, 'not_found', '没有这个内容组');
  const todo = [];
  let confirmed = 0;
  for (const q of data.qs) {
    if (q.answer_state === ANSWER_CONFIRMED) { confirmed++; continue; }
    const items = data.itemsBy.get(q.question_id) || [];
    todo.push(shapeQuestion(q, items, reviewRank(q, currentAnswer(q, items))));
  }
  todo.sort((a, b) => a.rank - b.rank || a.ord - b.ord);
  const flagged = todo.filter((q) => q.rank < 3);
  const rest = todo.filter((q) => q.rank === 3);
  const book = data.qs.filter((q) => q.book_answer);
  const bookSame = book.filter((q) => sameAnswer(q.book_answer, currentAnswer(q, data.itemsBy.get(q.question_id) || []))).length;
  return c.json({
    exam: { examId: data.exam.exam_id, label: data.exam.label },
    total: data.qs.length, confirmed, flagged, rest,
    bookCompare: book.length ? { compared: book.length, same: bookSame, rate: bookSame / book.length } : null,
  });
});

answersRouter.post('/exams/:examId/confirm-rest', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const data = await loadExam(db, c.req.param('examId'));
  if (!data) return bad(c, 404, 'not_found', '没有这个内容组');
  const body = await c.req.json().catch(() => ({}));
  const ids = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
  if (!ids.size) return bad(c, 400, 'invalid_request', '要给出整组确认的题');
  let pack;
  try { pack = await loadPackByCourse(db, data.exam.course_code); } catch (e) {
    return bad(c, 422, 'subject_pack_broken', `这门课的能力包读不出来，一道题都判不了：${e.message}`);
  }
  const confirmed = [];
  const kept = [];
  for (const q of data.qs) {
    if (!ids.has(q.question_id) || q.answer_state === ANSWER_CONFIRMED) continue;
    const items = data.itemsBy.get(q.question_id) || [];
    // 整组确认只确认"没有疑点的"：页面给的名单里混进了有疑点的，也留下来让人一道道看
    const rk = reviewRank(q, currentAnswer(q, items));
    if (rk.rank < 3) { kept.push({ questionId: q.question_id, ord: q.ord, reason: rk.reasons.map((r) => r.text).join('；') }); continue; }
    const problems = answerKeyProblems(pack, q, items, `第 ${q.ord} 题`);
    if (problems.length) { kept.push({ questionId: q.question_id, ord: q.ord, reason: problems.join('；') }); continue; }
    confirmed.push(q.question_id);
  }
  const who = me?.username || `user:${me?.id ?? '?'}`;
  const st = confirmed.map((id) => db.prepare(
    `UPDATE questions SET answer_state = '已确认', answer_reviewed_by = ?, answer_reviewed_at = datetime('now')
      WHERE question_id = ? AND answer_state <> '已确认'`
  ).bind(who, id));
  st.push(auditStmt(db, { actorId: me.id, action: 'answers.confirm_rest', target: data.exam.exam_id, after: { basis: '整组确认', confirmed, kept: kept.map((k) => k.questionId) } }));
  for (let i = 0; i < st.length; i += BATCH) await db.batch(st.slice(i, i + BATCH));
  return c.json({ ok: true, confirmed: confirmed.length, kept });
});

export const ANSWER_PAGE_PROMPT = [
  '这是一页书后的答案页照片。请把上面的题号和答案一一读出来，只输出 JSON，不要任何别的文字。',
  '形状：{"answers":[{"no":1,"answer":"C"},{"no":2,"answer":"absorb"}]}',
  '- 选择题答案写字母；填空、拼写写原文；一道题有几个答案用 / 隔开。',
  '- 看不清的那一题不要写，不要猜。',
].join('\n');

/** 答案页识别结果 → { 题号: 答案 }。形状不对就抛错。 */
export function parseAnswerPage(content) {
  let data;
  try { data = JSON.parse(String(content).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch {
    const e = new Error(`答案页识别结果不是 JSON（开头：${String(content).slice(0, 60)}）`); e.code = 'answer_page_bad_shape'; throw e;
  }
  if (!data || !Array.isArray(data.answers)) {
    const e = new Error(`答案页识别结果没有 answers 数组（顶层键：${Object.keys(data || {}).join(',') || '空'}）`); e.code = 'answer_page_bad_shape'; throw e;
  }
  const out = new Map();
  for (const a of data.answers) {
    const no = Number(a?.no);
    const ans = String(a?.answer ?? '').trim();
    if (Number.isInteger(no) && ans) out.set(no, ans);
  }
  return out;
}

answersRouter.post('/exams/:examId/answer-page', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const data = await loadExam(db, c.req.param('examId'));
  if (!data) return bad(c, 404, 'not_found', '没有这个内容组');
  const body = await c.req.json().catch(() => ({}));
  const image = String(body.image ?? '');
  const m = image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return bad(c, 400, 'invalid_image', '图片要是浏览器压缩好的 data:image/jpeg;base64,…');
  if (m[2].length * 0.75 > 4 * 1024 * 1024) return bad(c, 413, 'image_too_large', '压缩后的图片超过 4MB');
  const settings = await resolveSettings(c.env, 'PARSING');
  if (!settings) return bad(c, 422, 'ai_not_configured', '「图片解析 AI」还没配');
  // 一张答案页一次调用，当场识别、当场比；图只在这一次请求里，不存（同识别实测、导入）
  let book;
  let cost = null;
  try {
    const r = await chat(c.env, {
      purpose: 'PARSING', feature: 'answer_page', settings, maxTokens: 3000, timeoutMs: 90000,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: ANSWER_PAGE_PROMPT }] }],
    });
    cost = costOf(settings, r.usage);
    book = parseAnswerPage(r.content);
  } catch (e) {
    return bad(c, 422, e.code || 'answer_page_failed', `答案页没认出来：${e.message || e}`);
  }
  // 按题号对：一个内容组里几部分都从 1 编号时，答案页对不上是哪一部分——这种情况只比没有重号的题号
  const byNo = new Map();
  for (const q of data.qs) { if (!byNo.has(q.ord)) byNo.set(q.ord, []); byNo.get(q.ord).push(q); }
  const who = me?.username || `user:${me?.id ?? '?'}`;
  const st = [];
  let same = 0;
  const diff = [];
  const ambiguous = [];
  const stemKept = [];
  for (const [no, ans] of book) {
    const hits = byNo.get(no) || [];
    if (hits.length !== 1) { if (hits.length > 1) ambiguous.push(no); continue; }
    const q = hits[0];
    const cur = currentAnswer(q, data.itemsBy.get(q.question_id) || []);
    st.push(db.prepare(
      `INSERT INTO answer_review_flags (question_id, book_answer, book_checked_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(question_id) DO UPDATE SET book_answer = excluded.book_answer, book_checked_at = excluded.book_checked_at, updated_at = datetime('now')`
    ).bind(q.question_id, ans));
    if (cur && sameAnswer(ans, cur)) {
      same++;
      // 一致的确认（依据 = 原书比对）；已经确认过的不动。题面本身有问题的不替人确认：答案对上了，题面坏不坏还得人看
      if (q.stem_problem && q.answer_state !== ANSWER_CONFIRMED) stemKept.push(no);
      else if (q.answer_state !== ANSWER_CONFIRMED) {
        st.push(db.prepare(
          `UPDATE questions SET answer_state = '已确认', answer_reviewed_by = ?, answer_reviewed_at = datetime('now')
            WHERE question_id = ? AND answer_state <> '已确认'`
        ).bind(`${who}（与原书答案页一致）`, q.question_id));
      }
    } else diff.push({ questionId: q.question_id, ord: no, book: ans, ai: cur });
  }
  st.push(auditStmt(db, { actorId: me.id, action: 'answers.answer_page', target: data.exam.exam_id, after: { basis: '原书比对', read: book.size, same, diff: diff.length, cost } }));
  for (let i = 0; i < st.length; i += BATCH) await db.batch(st.slice(i, i + BATCH));
  const compared = same + diff.length;
  return c.json({ ok: true, read: book.size, compared, same, diff, ambiguous, stemKept, rate: compared ? same / compared : null, cost });
});

answersRouter.get('/exams/:examId/checklist', async (c) => {
  const data = await loadExam(c.env.DB, c.req.param('examId'));
  if (!data) return bad(c, 404, 'not_found', '没有这个内容组');
  const rows = data.qs.map((q) => {
    const items = data.itemsBy.get(q.question_id) || [];
    return { q, cur: currentAnswer(q, items), rk: reviewRank(q, currentAnswer(q, items)) };
  }).sort((a, b) => a.rk.rank - b.rk.rank || a.q.ord - b.q.ord);
  const L = [`# 答案核对单：${data.exam.label}`, '', `共 ${rows.length} 题，已确认 ${rows.filter((r) => r.q.answer_state === ANSWER_CONFIRMED).length} 题。拿不准的排在前面。`, ''];
  L.push('| 题 | 题干 | 答案 | 状态 | 要看的 |', '|---|---|---|---|---|');
  for (const { q, cur, rk } of rows) {
    const stem = String(q.stem || '').replace(/\s+/g, ' ').replace(/\|/g, '｜').slice(0, 60);
    L.push(`| ${q.section_type} 第 ${q.ord} 题${q.source_page ? `（第 ${q.source_page} 页）` : ''} | ${stem} | ${String(cur ?? '—').replace(/\|/g, '｜')} | ${q.answer_state} | ${rk.reasons.map((r) => r.text).join('；').replace(/\|/g, '｜') || ''} |`);
  }
  return c.text(L.join('\n'), 200, { 'Content-Type': 'text/markdown; charset=utf-8' });
});
