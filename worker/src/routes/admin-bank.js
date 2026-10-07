import { Hono } from 'hono';
import { validateAssets } from '../lib/stem-assets.js';
import { ANSWER_CONFIRMED, isAnswerState, isAnswerSource } from '../lib/pickable.js';
import { shapeContentGroup, ORDER_BY_RECENT } from '../lib/content-group.js';
import { inputGroupsWithoutAnswer, loadItemRows, JUDGE_KINDS } from '../lib/question-items.js';
import { examReadiness } from '../lib/paper.js';
import { answerKeyProblems } from '../lib/answer-check.js';
import { loadPackByCourse, loadPacksForCourses } from '../lib/subject-pack.js';
import { isQuotaError } from '../lib/auth.js';

export const bankRouter = new Hono();

// 标准答案自检要先读这门课的能力包。能力包读不出来（题型没配判分策略、配置 JSON 写坏了……）时，
// 这门课的题一道都判不了分，自检也就做不了：确认、发布照样拒绝，但要说清是能力包坏了、坏在哪——
// 以前这里直接抛出去，管理员只看到一句"服务器内部错误"（n3-pack 照出来的）。
// 只认能力包加载器自己报的错（带 code）；数据库的错、额度用尽照常抛给全局处理。
async function packForCheck(c, courseCode) {
  try {
    return { pack: await loadPackByCourse(c.env.DB, courseCode) };
  } catch (e) {
    if (!e?.code || isQuotaError(e)) throw e;
    return {
      refusal: c.json({
        error: 'subject_pack_broken',
        message: `课程 ${courseCode} 的能力包读不出来，判不了分，确认、发布、增删采分点都做不了。` +
          `先在后台「学科配置」把它改好：${String(e.message).replace(/^[a-z_]+: /, '')}`,
      }, 422),
    };
  }
}

// 每门课现在能不能组出一张卷（只读体检）。生化的组卷模板漏装过一次（2026-10-04 才补上），
// 学员点「生成试卷」才知道；部署后的线上验证靠这个接口把"有已发布章节却没有模板"报红。
bankRouter.get('/exam-readiness', async (c) => {
  return c.json({ courses: await examReadiness(c.env.DB) });
});

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

  // 考点分布按学科分开：两个学科里同名的考点是两个考点，按名字并在一起数就把它们混成了一个。
  // 不属于任何学科的（按理不该有）排在最后、学科码为 null，界面上单列一组，不悄悄丢掉。
  const { results: byTag } = await c.env.DB.prepare(
    `SELECT k.tag_id, k.name, s.code AS subject_code, s.name AS subject_name, COUNT(*) AS total,
            SUM(CASE WHEN q.status = '已发布' THEN 1 ELSE 0 END) AS published
     FROM question_knowledge_points x
     JOIN knowledge_points k ON k.tag_id = x.tag_id
     JOIN questions q ON q.question_id = x.question_id
     LEFT JOIN subjects s ON s.subject_id = k.subject_id
     GROUP BY k.tag_id
     ORDER BY s.subject_id IS NULL, s.sort_order, s.subject_id, total DESC, k.name`
  ).all();

  const pending = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM exam_parsing_notes WHERE resolved = 0`
  ).first();

  // §6.4.10：缺答案题数按学科分开数——它是内容建设进度，混在一起看不出哪一科卡着。
  const { results: answers } = await c.env.DB.prepare(
    `SELECT s.code AS subject_code, s.name AS subject_name,
            SUM(CASE WHEN q.answer_state = '缺答案' THEN 1 ELSE 0 END) AS no_answer,
            SUM(CASE WHEN q.answer_state = '待核' THEN 1 ELSE 0 END) AS unreviewed,
            SUM(CASE WHEN q.answer_state = '已确认' THEN 1 ELSE 0 END) AS confirmed
       FROM questions q JOIN subjects s ON s.subject_id = q.subject_id
      GROUP BY s.subject_id ORDER BY s.sort_order, s.subject_id`
  ).all();

  // §6.4.10 的硬约束在看板上的落点：**已发布但答案没确认的题，永远应该是 0**。
  // 分开数 status 和 answer_state 看不出这件事——两栏各自都正常，
  // 交叉起来才是"把没人核过的答案发给了学员"。线上验证就断这一个数。
  const leak = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM questions WHERE status = '已发布' AND answer_state <> '已确认'`
  ).first();

  // CR-H4：停用的题。停用时已发布的会退回草稿，所以"已发布又停用"应当永远是 0——
  // 和上面那个一样，单独算出来给线上验证断：哪条发布的路漏了停用判断，这里就不是 0。
  const retired = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN status = '已发布' THEN 1 ELSE 0 END) AS published
       FROM questions WHERE retired_at IS NOT NULL`
  ).first();

  const ungradable = await publishedUngradable(c.env.DB);

  return c.json({
    byCourse, byType, byTag, byAnswerState: answers,
    unresolvedNotes: pending?.n || 0,
    publishedWithoutConfirmedAnswer: leak?.n || 0,
    retiredQuestions: retired?.n || 0,
    retiredButPublished: retired?.published || 0,
    publishedUngradable: ungradable.length,
    publishedUngradableSample: ungradable.slice(0, 10),
  });
});

/**
 * 已发布的题里，按标准答案作答都拿不到满分的（answer-check.js，2026-10-07）。
 *
 * 和上面两个一样**永远应该是 0**，线上验证断它。确认、发布两道关已经拦了，这里是给别的入口留的后手：
 * 种子导入、测试夹具直接改库、以后加的什么路。第 1 章 q04、q05 那次（题库写的是 params.enum、
 * 判分器只认 options）就是从种子进来、一路发布、学员一交答案才 500 的。
 * 能力包读不出来的那门课，它的每道题都算一条，说清是能力包的问题——不让整个看板 500。
 */
async function publishedUngradable(db) {
  const { results: qs } = await db.prepare(
    `SELECT question_id, course_code, exam_id, ord, question_type, answer FROM questions
      WHERE status = '已发布' AND retired_at IS NULL`
  ).all();
  if (!qs.length) return [];
  const { results: itemRows } = await db.prepare(
    `SELECT i.* FROM question_items i JOIN questions q ON q.question_id = i.question_id
      WHERE q.status = '已发布' AND q.retired_at IS NULL ORDER BY i.question_id, i.item_ord`
  ).all();
  const itemsBy = new Map();
  for (const r of itemRows) {
    if (!itemsBy.has(r.question_id)) itemsBy.set(r.question_id, []);
    itemsBy.get(r.question_id).push(r);
  }
  const packs = new Map();
  for (const code of new Set(qs.map((q) => q.course_code))) {
    try {
      packs.set(code, (await loadPacksForCourses(db, [code])).get(code));
    } catch (e) {
      packs.set(code, { error: String(e?.message || e) });
    }
  }
  const out = [];
  for (const q of qs) {
    const pack = packs.get(q.course_code);
    const where = `${q.exam_id} 第${q.ord}题`;
    const problems = !pack || pack.error
      ? [`${where}：课程 ${q.course_code} 的能力包读不出来（${pack?.error || '没有这门课'}）`]
      : answerKeyProblems(pack, q, itemsBy.get(q.question_id) || [], where);
    if (problems.length) out.push({ questionId: q.question_id, problems });
  }
  return out;
}

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
    `SELECT e.exam_id, e.course_code, co.course_name, e.title, e.label, e.order_key, e.meta,
            e.year, e.month, e.status, e.created_at, e.published_at,
            (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.exam_id) AS question_count,
            (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.exam_id AND q.reviewed = 1) AS reviewed_count,
            (SELECT COUNT(*) FROM questions q WHERE q.exam_id = e.exam_id
               AND q.answer_state <> '${ANSWER_CONFIRMED}') AS missing_answer_count,
            (SELECT COUNT(*) FROM exam_parsing_notes p WHERE p.exam_id = e.exam_id AND p.resolved = 0) AS open_notes
     FROM exams e JOIN courses co ON co.course_code = e.course_code
     ${where}
     ${ORDER_BY_RECENT}`
  ).bind(...binds).all();

  return c.json({ exams: results.map(shapeContentGroup) });
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

  // 得分单元（N5）。**不带上它，一题多空的答案在校对页就是看不见的**：
  // questions.answer 只有单答案题才填，填空题的答案逐空存在 question_items 里。
  // 生化第 1 章 34 道题有 21 道属于后者，界面上一律显示"答案：—"，
  // 看起来像"AI 没生成答案"，其实是这个接口根本没查这张表。
  const { results: itemRows } = await c.env.DB.prepare(
    `SELECT i.* FROM question_items i
       JOIN questions q ON q.question_id = i.question_id
      WHERE q.exam_id = ? ORDER BY i.question_id, i.item_ord`
  ).bind(examId).all();
  const itemsBy = new Map();
  for (const r of itemRows) {
    if (!itemsBy.has(r.question_id)) itemsBy.set(r.question_id, []);
    const j = (raw, fallback) => {
      if (raw === null || raw === undefined || raw === '') return fallback;
      try { return JSON.parse(raw); } catch { return fallback; }
    };
    itemsBy.get(r.question_id).push({
      ord: r.item_ord,
      kind: r.item_kind,
      strategy: r.grading_strategy,
      groupKey: r.group_key,
      answer: r.answer,
      altAnswers: j(r.alt_answers, []),
      weight: r.weight,
      params: j(r.params, {}),
    });
  }

  // 题型按什么判：校对页要知道哪些题该有采分点（名词解释、问答），好让管理员给没有采分点的题补上。
  // 读不出能力包不拦校对页（题面、答案照样要能看能改），只是不标这一项。
  let pack = null;
  try { pack = await loadPackByCourse(c.env.DB, exam.course_code); } catch { pack = null; }
  const pointsTypeOf = (code) => {
    try { return pack ? pack.typeOf(code).gradingStrategy === 'AI_SCORE_POINTS' : false; } catch { return false; }
  };

  const shaped = sections.map((s) => ({
    ...s,
    questions: questions
      .filter((q) => q.section_id === s.section_id)
      .map((q) => ({
        ...q,
        options: q.options ? JSON.parse(q.options) : null,
        knowledgePoints: q.tag_names ? q.tag_names.split('||') : [],
        items: itemsBy.get(q.question_id) || [],
        pointsType: pointsTypeOf(q.question_type),
      })),
  }));

  return c.json({ exam: shapeContentGroup(exam), sections: shaped, parsingNotes: notes });
});

// 校对：修改单题
bankRouter.patch('/questions/:questionId', async (c) => {
  const me = c.get('user');
  const questionId = c.req.param('questionId');
  const body = await c.req.json().catch(() => ({}));
  const existing = await c.env.DB.prepare('SELECT * FROM questions WHERE question_id = ?')
    .bind(questionId).first();
  if (!existing) return c.json({ error: 'not_found' }, 404);
  // 考点按这道题的学科找、按这个学科建（见下面"考点标签整体替换"）。读不到学科就一个字都不写：
  // 放到后面再拦的话，题面、答案已经先存进去了，返回的却是失败。
  if (Array.isArray(body.knowledgePoints) && existing.subject_id == null) {
    return c.json({
      error: 'question_without_subject',
      message: `${questionId} 没有学科，考点不知道该记到哪一科下`,
    }, 422);
  }

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
  // answerState 与 status 可能在同一次请求里一起改（"录完答案顺手发布"），
  // 所以先算出这次改完之后答案状态是什么，再拿它去卡 status。
  // 只看库里的旧值会把这种请求误拒，只看 body 又会漏掉单独改 status 的请求。
  let nextAnswerState = existing.answer_state;
  if ('answerState' in body) {
    if (!isAnswerState(body.answerState)) {
      return c.json({ error: 'invalid_answer_state', message: `答案状态只能是 缺答案 / 待核 / 已确认，收到 ${JSON.stringify(body.answerState)}` }, 400);
    }
    nextAnswerState = body.answerState;
    fields.push('answer_state = ?'); binds.push(nextAnswerState);
    // 留痕（§6.4.10）：确认时记下是谁、什么时候；退回未确认时把留痕清掉，
    // 免得下次看到一个早就作废的"某某已确认"。
    if (nextAnswerState === ANSWER_CONFIRMED) {
      fields.push('answer_reviewed_by = ?', "answer_reviewed_at = datetime('now')");
      binds.push(me?.username || `user:${me?.id ?? '?'}`);
    } else {
      fields.push('answer_reviewed_by = NULL', 'answer_reviewed_at = NULL');
    }
  }
  if ('answerSource' in body) {
    if (!isAnswerSource(body.answerSource)) {
      return c.json({ error: 'invalid_answer_source', message: `答案来源只能是 OFFICIAL / MANUAL / AI，收到 ${JSON.stringify(body.answerSource)}` }, 400);
    }
    fields.push('answer_source = ?'); binds.push(body.answerSource);
  }
  if ('status' in body) {
    if (!['草稿', '已发布', '存疑'].includes(body.status)) {
      return c.json({ error: 'invalid_status' }, 400);
    }
    // §6.4.10 的硬约束：答案没经人工确认的题不能发布。
    // AI 生成的答案自动上线 = 所有答对的学生被判错，而没有任何地方会报错。
    if (body.status === '已发布' && nextAnswerState !== ANSWER_CONFIRMED) {
      return c.json({
        error: 'answer_not_confirmed',
        message: `这道题的答案状态是「${nextAnswerState ?? '未设置'}」，确认之后才能发布`,
        answerState: nextAnswerState ?? null,
      }, 422);
    }
    // CR-H4：停用的题不能发布，先恢复（恢复后是草稿，再在这里发布）
    if (body.status === '已发布' && existing.retired_at) {
      return c.json({
        error: 'question_retired',
        message: `这道题 ${existing.retired_at} 被停用了，先恢复再发布`,
      }, 409);
    }
    fields.push('status = ?'); binds.push(body.status);
  }
  if ('reviewed' in body) { fields.push('reviewed = ?'); binds.push(body.reviewed ? 1 : 0); }

  // ---- 得分单元的答案（N5 之后，一题多空的答案在这里，不在 questions.answer）----
  //
  // 上面那个 `answer` 字段对填空题是**装饰**：判分读的是 question_items.answer。
  // 不让改这里的话，校对页看得见答案却改不动，而在"参考答案"框里改完还会以为改好了。
  const existingItems = (await c.env.DB.prepare(
    'SELECT * FROM question_items WHERE question_id = ? ORDER BY item_ord'
  ).bind(questionId).all()).results || [];
  // 改之前的样子：下面的标准答案自检要分清"这次改坏了"和"本来就是坏的"，说法不一样
  const itemsBefore = existingItems.map((r) => ({ ...r }));

  const itemWrites = [];
  if ('items' in body) {
    if (!Array.isArray(body.items)) {
      return c.json({ error: 'invalid_items', message: 'items 要是数组' }, 400);
    }
    const byOrd = new Map(existingItems.map((r) => [Number(r.item_ord), r]));
    for (const patchItem of body.items) {
      const ord = Number(patchItem?.ord);
      if (!byOrd.has(ord)) {
        // 不认识的序号就报错，不静默跳过：跳过的话调用方以为改成功了，
        // 而库里一个字没动——这正是"读不到值就抛错"要拦的那类事。
        return c.json({
          error: 'unknown_item_ord',
          message: `这道题没有第 ${JSON.stringify(patchItem?.ord)} 个得分单元（有 ${
            [...byOrd.keys()].join('、') || '（无）'}）`,
        }, 400);
      }
      const row = byOrd.get(ord);
      if ('answer' in patchItem) {
        const v = patchItem.answer === null ? null : String(patchItem.answer);
        itemWrites.push(['answer', v, ord]);
        row.answer = v;
      }
      if ('altAnswers' in patchItem) {
        if (patchItem.altAnswers !== null && !Array.isArray(patchItem.altAnswers)) {
          return c.json({
            error: 'invalid_alt_answers',
            message: `第 ${ord} 个单元的 altAnswers 要是数组或 null`,
          }, 400);
        }
        const arr = Array.isArray(patchItem.altAnswers)
          ? patchItem.altAnswers.map((x) => String(x)).filter((x) => x.trim()) : [];
        const v = arr.length ? JSON.stringify(arr) : null;
        itemWrites.push(['alt_answers', v, ord]);
        row.alt_answers = v;
      }
      if ('weight' in patchItem) {
        // 权重只给采分点、步骤改：候选池（SET）组内的空权重必须齐平（判分器会拒），
        // 在这里开口子等于让人一不小心把一道题改得判不了分。
        if (!JUDGE_KINDS.includes(row.item_kind)) {
          return c.json({
            error: 'item_weight_not_editable',
            message: `第 ${ord} 个单元是${row.item_kind === 'BLANK' ? '填空的空' : row.item_kind}，权重不在这里改`,
          }, 400);
        }
        const w = Number(patchItem.weight);
        if (!Number.isFinite(w) || w <= 0) {
          return c.json({ error: 'invalid_item_weight', message: `第 ${ord} 个采分点的权重要是正数，收到 ${JSON.stringify(patchItem.weight)}` }, 400);
        }
        itemWrites.push(['weight', w, ord]);
        row.weight = w;
      }
    }
  }

  // ---- 采分点的增删（2026-10-07）----
  // 上传进来的名词解释、问答，采分点是 AI 拆的，拆多了、拆少了都得能纠正；老的上传章节一个采分点都没有
  // （只有一整段参考答案），要能在这里补上——否则这类题进了卷子，AI 每次批改都失败。
  // 只增删判定单元（采分点 / 步骤）：填空的空对应题干里的＿，增删空等于改题干，不在这里做。
  // 学员做过的题不增删：作答记录里的逐点结果按序号记，删掉一个点、旧报告就对不上了。改文字、改权重照样可以。
  const removeOrds = 'removeItems' in body ? body.removeItems : [];
  const adds = 'addItems' in body ? body.addItems : [];
  if (!Array.isArray(removeOrds) || !Array.isArray(adds)) {
    return c.json({ error: 'invalid_items', message: 'removeItems、addItems 要是数组' }, 400);
  }
  const itemDeletes = [];
  const itemInserts = [];
  if (removeOrds.length || adds.length) {
    const used = await c.env.DB.prepare('SELECT 1 AS x FROM answer_records WHERE question_id = ? LIMIT 1')
      .bind(questionId).first();
    if (used) {
      return c.json({
        error: 'item_structure_locked',
        message: '学员已经做过这道题，不能增删采分点（改文字、改权重可以）。要改结构，停用这道题，再加一道新题',
      }, 409);
    }
    for (const raw of removeOrds) {
      const ord = Number(raw);
      const i = existingItems.findIndex((r) => Number(r.item_ord) === ord);
      if (i < 0 || !JUDGE_KINDS.includes(existingItems[i].item_kind)) {
        return c.json({
          error: 'unknown_item_ord',
          message: `这道题没有第 ${JSON.stringify(raw)} 个采分点可删（只能删采分点、步骤）`,
        }, 400);
      }
      existingItems.splice(i, 1);
      itemDeletes.push(ord);
    }
    if (adds.length) {
      const { pack, refusal } = await packForCheck(c, existing.course_code);
      if (refusal) return refusal;
      let type;
      try {
        type = pack.typeOf(existing.question_type);
      } catch (e) {
        if (!e?.code) throw e;
        return c.json({ error: e.code, message: String(e.message).replace(/^[a-z_]+: /, '') }, 422);
      }
      if (type.gradingStrategy !== 'AI_SCORE_POINTS') {
        return c.json({
          error: 'points_not_supported',
          message: `题型「${type.name}」不按采分点判分，不能加采分点`,
        }, 400);
      }
      if (existingItems.some((r) => !JUDGE_KINDS.includes(r.item_kind))) {
        return c.json({
          error: 'points_not_supported',
          message: '这道题是逐空作答的，不能再加采分点（两类单元混在一道题里，判分时拆不出每个单元对应哪段作答）',
        }, 400);
      }
      const judges = existingItems.filter((r) => JUDGE_KINDS.includes(r.item_kind));
      const kind = judges.length && judges.every((r) => r.item_kind === 'STEP') ? 'STEP' : 'SCORE_POINT';
      let next = Math.max(0, ...existingItems.map((r) => Number(r.item_ord)), ...itemDeletes) + 1;
      for (const a of adds) {
        const text = String(a?.answer ?? '').trim();
        if (!text) {
          return c.json({ error: 'invalid_items', message: '新加的采分点没有内容' }, 400);
        }
        const w = a?.weight === undefined || a?.weight === null || a?.weight === '' ? 1 : Number(a.weight);
        if (!Number.isFinite(w) || w <= 0) {
          return c.json({ error: 'invalid_item_weight', message: `新加的采分点权重要是正数，收到 ${JSON.stringify(a.weight)}` }, 400);
        }
        const row = {
          question_id: questionId, item_ord: next, subject_id: existing.subject_id, item_kind: kind,
          grading_strategy: null, group_key: null, answer: text, alt_answers: null, weight: w, params: null,
        };
        existingItems.push(row);
        itemInserts.push(row);
        next += 1;
      }
    }
  }

  // §6.4.10 的硬约束往前挪一步：**确认**的时候就要求答案真的在。
  //
  // 发布那道关只看 answer_state，所以"确认了但空还是空的"能一路发到学员面前，
  // 判分时 acceptedForms 抛 item_without_answer——学员看到的是一次失败的交卷。
  // existingItems 已经就地带上了这次要写的值，所以"补上答案顺手确认"是允许的。
  if (nextAnswerState === ANSWER_CONFIRMED) {
    const missing = inputGroupsWithoutAnswer(existingItems, '这道题');
    if (missing.length) {
      // 两种走到这里的情形，说法不一样，否则第二种会让人一头雾水：
      //   ① 正在确认 → "答案还不全，确认不了"
      //   ② 这道题本来就是已确认，这次要把某个空清空 → 拦的是"确认态下留一个空答案"，
      //      而请求里根本没有 answerState，报"确认不了"会让人以为自己按错了按钮。
      const confirming = 'answerState' in body;
      return c.json({
        error: 'item_answer_missing',
        message: confirming
          ? `答案还不全，确认不了：${missing.join('；')}`
          : '这道题的答案状态是「已确认」，清空答案会留下一个"确认过但没有答案"的题——'
            + `判分时会抛 item_without_answer。要改答案请把状态一并退回「待核」。（${missing.join('；')}）`,
        problems: missing,
        confirming,
      }, 422);
    }
  }

  // 标准答案自检（2026-10-07）：答案齐了还不够，要用判分器把它判一遍、拿得到满分才算数。
  // 上面那道只看"有没有"，看不出"受限选择的答案不在给定的几个里""候选池两个写法归一化后撞了"
  // "名词解释没有采分点"——这些题确认了、发布了，学员一交答案就 500 或永远批不完。
  // 只在动到判分的请求上查（确认、发布、改答案、改得分单元）：只改考点、改解析的请求不该被
  // 一道早就有问题的题卡住——那种题由整卷发布和看板（publishedUngradable）兜着。
  // 校对页保存时整张表单都发过来，所以"动没动到判分"看的是请求里有没有这些键，不是值变没变。
  const gradingTouched = ['answer', 'answerState', 'status', 'items', 'addItems', 'removeItems']
    .some((k) => k in body);
  if (nextAnswerState === ANSWER_CONFIRMED && gradingTouched) {
    const { pack, refusal } = await packForCheck(c, existing.course_code);
    if (refusal) return refusal;
    const after = { ...existing, ...('answer' in body ? { answer: body.answer } : {}) };
    const problems = answerKeyProblems(pack, after, existingItems, '这道题');
    if (problems.length) {
      const confirming = existing.answer_state !== ANSWER_CONFIRMED;
      const publishing = body.status === '已发布' && existing.status !== '已发布';
      const wasBroken = !confirming && answerKeyProblems(pack, existing, itemsBefore, '这道题').length > 0;
      return c.json({
        error: 'answer_key_unusable',
        message: (confirming ? '标准答案判不出满分，确认不了：'
          : publishing ? '标准答案判不出满分，发布不了：'
          : wasBroken ? '这道题标着「已确认」，标准答案却判不出满分。改好它，或者把答案状态退回「待核」再保存：'
          : '这样改完，已确认的答案就判不出满分了（要这样改，请把答案状态一并退回「待核」）：')
          + problems.join('；'),
        problems,
      }, 422);
    }
  }

  if (fields.length) {
    binds.push(questionId);
    await c.env.DB.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE question_id = ?`)
      .bind(...binds).run();
  }

  // 得分单元一个 batch 写完：删、改、加要么全成、要么全不成——删了旧点没加上新点，题就判不了了
  const itemStmts = [
    ...itemDeletes.map((ord) => c.env.DB.prepare(
      'DELETE FROM question_items WHERE question_id = ? AND item_ord = ?').bind(questionId, ord)),
    ...itemWrites.map(([col, val, ord]) => c.env.DB.prepare(
      `UPDATE question_items SET ${col} = ? WHERE question_id = ? AND item_ord = ?`).bind(val, questionId, ord)),
    ...itemInserts.map((r) => c.env.DB.prepare(
      `INSERT INTO question_items (question_id, item_ord, subject_id, item_kind, grading_strategy, group_key,
                                   answer, alt_answers, weight, params)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, NULL, ?, NULL)`
    ).bind(questionId, r.item_ord, r.subject_id, r.item_kind, r.answer, r.weight)),
  ];
  if (itemStmts.length) await c.env.DB.batch(itemStmts);

  // 考点标签整体替换。只在这道题所属的学科里按名字找，找不到就在这个学科下新建。
  // 以前是全库按名字找、新建的不带学科：生化题打上一个英语考点的名字，挂上的就是英语那个；
  // 新建的哪一科都不属于，在哪一科的候选列表里都看不到。
  if (Array.isArray(body.knowledgePoints)) {
    await c.env.DB.prepare('DELETE FROM question_knowledge_points WHERE question_id = ?')
      .bind(questionId).run();
    for (const name of body.knowledgePoints) {
      let tag = await c.env.DB.prepare('SELECT tag_id FROM knowledge_points WHERE subject_id = ? AND name = ?')
        .bind(existing.subject_id, name).first();
      if (!tag) {
        const tagId = `kp-${crypto.randomUUID().slice(0, 8)}`;
        await c.env.DB.prepare('INSERT INTO knowledge_points (tag_id, name, subject_id) VALUES (?, ?, ?)')
          .bind(tagId, name, existing.subject_id).run();
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

  // N3：题型的 CHECK 从表上去掉了（题型由学科声明），校验挪到这里。
  // 发布是"这道题从此会被抽给学员"的那一刻，也是最后一道关：题型没在该学科
  // 声明过的话，判分时 pack.typeOf 会抛错，学员看到的是一次失败的交卷。
  // 在这里拦住，并且把是哪几道题、什么题型说出来——CHECK 只会给一句约束失败。
  const { results: badTypes } = await c.env.DB.prepare(
    `SELECT q.question_id, q.ord, q.question_type
       FROM questions q
      WHERE q.exam_id = ? AND q.status != '存疑' AND q.retired_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM subject_question_types t
           WHERE t.subject_id = q.subject_id AND t.type_code = q.question_type)
      ORDER BY q.ord LIMIT 20`
  ).bind(examId).all();
  if (badTypes.length) {
    return c.json({
      error: 'question_type_not_declared',
      message: `有 ${badTypes.length} 道题的题型没在本学科声明过：` +
        badTypes.map((b) => `第${b.ord}题(${b.question_type})`).join('、'),
      questions: badTypes,
    }, 422);
  }

  // N5b：富媒体题干的契约（§6.4.6、G2）。这里查的是**发布那一刻库里的实际内容**，
  // 与种子生成那道校验不是重复：题也可以从后台改，改完 alt 空了、![key] 拼错了，
  // 种子那道关根本不会再跑。查不了文件在不在（Worker 没有文件系统），
  // 那条由种子生成时的 fileExists 负责。
  const { results: assetRows } = await c.env.DB.prepare(
    `SELECT q.question_id, q.ord, q.stem, q.options,
            a.asset_key, a.kind, a.path, a.alt
       FROM questions q
       LEFT JOIN question_assets a ON a.question_id = q.question_id
      WHERE q.exam_id = ? AND q.status != '存疑' AND q.retired_at IS NULL
        AND (a.asset_key IS NOT NULL OR q.stem LIKE '%![%')
      ORDER BY q.ord`
  ).bind(examId).all();
  if (assetRows.length) {
    const byQuestion = new Map();
    for (const r of assetRows) {
      if (!byQuestion.has(r.question_id)) {
        let options = null;
        try { options = r.options ? JSON.parse(r.options) : null; } catch { options = null; }
        byQuestion.set(r.question_id, { ord: r.ord, stem: r.stem, options, assets: [] });
      }
      if (r.asset_key) {
        byQuestion.get(r.question_id).assets.push(
          { key: r.asset_key, kind: r.kind, path: r.path, alt: r.alt });
      }
    }
    const problems = [];
    for (const [questionId, qu] of byQuestion) {
      problems.push(...validateAssets(
        { questionId: `第${qu.ord}题`, stem: qu.stem, options: qu.options }, qu.assets));
    }
    if (problems.length) {
      return c.json({
        error: 'asset_contract_failed',
        message: `有 ${problems.length} 处题目资源不合契约，发布被拒`,
        problems: problems.slice(0, 20),
      }, 422);
    }
  }

  // 输入单元没有标准答案的题，判分时 acceptedForms 会抛 item_without_answer——
  // 和上面题型那道关是同一类事：**学员看到的是一次失败的交卷**，而题库里看不出问题。
  // 这里整卷拒绝而不是扣下：answer_state 已确认、空却是空的，是一对矛盾的状态，
  // 扣下等于把矛盾藏起来。校对页的确认那一步已经拦了一道，这是给别的入口
  // （种子、上传、直接改库）留的后手。
  const { results: pubItems } = await c.env.DB.prepare(
    `SELECT q.question_id, q.ord, i.item_ord, i.item_kind, i.group_key, i.answer,
            i.alt_answers, i.params
       FROM questions q JOIN question_items i ON i.question_id = q.question_id
      WHERE q.exam_id = ? AND q.status != '存疑' AND q.answer_state = ? AND q.retired_at IS NULL
      ORDER BY q.ord, i.item_ord`
  ).bind(examId, ANSWER_CONFIRMED).all();
  if (pubItems.length) {
    const byQ = new Map();
    for (const r of pubItems) {
      if (!byQ.has(r.question_id)) byQ.set(r.question_id, { ord: r.ord, rows: [] });
      byQ.get(r.question_id).rows.push(r);
    }
    const itemProblems = [];
    for (const [, q] of byQ) {
      itemProblems.push(...inputGroupsWithoutAnswer(q.rows, `第${q.ord}题`));
    }
    if (itemProblems.length) {
      return c.json({
        error: 'item_answer_missing',
        message: `有 ${itemProblems.length} 处得分单元标着「已确认」却没有标准答案，发布被拒`,
        problems: itemProblems.slice(0, 20),
      }, 422);
    }
  }

  // 标准答案自检（2026-10-07，answer-check.js）：确认过的题，按标准答案作答也得拿满分。
  // 和上面"确认了却没有答案"是同一类矛盾，所以同样整卷拒绝、不扣下；要先发别的题，
  // 把有问题的那几道退回「待核」（待核的题不随整卷发布）。
  const { results: confirmedQs } = await c.env.DB.prepare(
    `SELECT question_id, ord, question_type, answer FROM questions
      WHERE exam_id = ? AND status != '存疑' AND answer_state = ? AND retired_at IS NULL
      ORDER BY ord`
  ).bind(examId, ANSWER_CONFIRMED).all();
  if (confirmedQs.length) {
    const { pack, refusal } = await packForCheck(c, exam.course_code);
    if (refusal) return refusal;
    const itemsBy = await loadItemRows(c.env.DB, confirmedQs.map((q) => q.question_id));
    const keyProblems = confirmedQs.flatMap((q) =>
      answerKeyProblems(pack, q, itemsBy.get(q.question_id) || [], `第${q.ord}题`));
    if (keyProblems.length) {
      return c.json({
        error: 'answer_key_unusable',
        message: `有 ${keyProblems.length} 处标准答案判不出满分，发布被拒。改好之后再发布，` +
          '或者先把这几道退回「待核」（待核的题不随整卷发布）',
        problems: keyProblems.slice(0, 20),
      }, 422);
    }
  }

  // N6（§6.4.10、B14）：答案没确认的题扣下不发。
  //
  // 为什么是扣下而不是整卷拒绝：分章上线是明确允许的（§12 的风险条目——
  // 核完一章发一章），而生化一章 34 道题不可能同时核完。存疑的题本来就是这么处理的。
  // 但**扣下必须说出来**：界面上看到"已发布"而实际只发了 30/34，
  // 又没有任何地方提示，那是最糟的一种"成功"。
  const { results: noAnswer } = await c.env.DB.prepare(
    `SELECT question_id, ord, answer_state FROM questions
      WHERE exam_id = ? AND status != '存疑' AND answer_state <> ? AND retired_at IS NULL
      ORDER BY ord`
  ).bind(examId, ANSWER_CONFIRMED).all();

  // 标记为存疑、答案未确认、已停用（CR-H4）的题目不随整卷发布
  await c.env.DB.prepare(
    `UPDATE questions SET status = '已发布'
      WHERE exam_id = ? AND status != '存疑' AND answer_state = ? AND retired_at IS NULL`
  ).bind(examId, ANSWER_CONFIRMED).run();
  await c.env.DB.prepare(
    `UPDATE exams SET status = '已发布', published_at = datetime('now') WHERE exam_id = ?`
  ).bind(examId).run();

  const counts = await c.env.DB.prepare(
    `SELECT SUM(CASE WHEN status = '已发布' THEN 1 ELSE 0 END) AS published,
            SUM(CASE WHEN status = '存疑' THEN 1 ELSE 0 END) AS held
     FROM questions WHERE exam_id = ?`
  ).bind(examId).first();

  return c.json({
    ok: true,
    published: counts?.published || 0,
    held: counts?.held || 0,
    heldNoAnswer: noAnswer.length,
    noAnswerQuestions: noAnswer.slice(0, 20),
    message: noAnswer.length
      ? `已发布 ${counts?.published || 0} 道；另有 ${noAnswer.length} 道答案未确认被扣下（第` +
        `${noAnswer.slice(0, 10).map((q) => q.ord).join('、')}${noAnswer.length > 10 ? '…' : ''}题）`
      : undefined,
  });
});

// 单题停用（CR-H4）。导入过的题库文件不许改（用户 2026-10-01 定的规矩）：题的内容错了，
// 在这里把旧题停用，再用新的内容组编号加一个新文件。停用之后抽题抽不到（pickableSql）、
// 整卷发布跳过它、学员错题本不再显示它；作答记录和成绩报告照旧引用它——那是已经发生的事。
// 已发布的退回草稿：不留"已发布但停用"的半截状态，否则凡是数已发布题数的地方都得各自记得
// 再排除一次停用（看板的 retiredButPublished 盯着这件事）。
bankRouter.post('/questions/:questionId/retire', async (c) => {
  const me = c.get('user');
  const questionId = c.req.param('questionId');
  const q = await c.env.DB.prepare('SELECT status, retired_at FROM questions WHERE question_id = ?')
    .bind(questionId).first();
  if (!q) return c.json({ error: 'not_found' }, 404);
  if (q.retired_at) {
    return c.json({ error: 'already_retired', message: `这道题 ${q.retired_at} 已经停用了` }, 409);
  }
  await c.env.DB.prepare(
    `UPDATE questions SET retired_at = datetime('now'), retired_by = ?,
            status = CASE WHEN status = '已发布' THEN '草稿' ELSE status END
      WHERE question_id = ? AND retired_at IS NULL`
  ).bind(me?.username || `user:${me?.id ?? '?'}`, questionId).run();
  const after = await c.env.DB.prepare(
    'SELECT status, retired_at, retired_by FROM questions WHERE question_id = ?'
  ).bind(questionId).first();
  return c.json({ ok: true, wasPublished: q.status === '已发布', ...after });
});

// 恢复：只撤销停用。题保持停用时退回的状态（一般是草稿），要在校对页重新发布才对学员可见
// （用户 2026-10-01 定的：防误点，但恢复不等于直接上线）。
bankRouter.post('/questions/:questionId/restore', async (c) => {
  const questionId = c.req.param('questionId');
  const q = await c.env.DB.prepare('SELECT retired_at FROM questions WHERE question_id = ?')
    .bind(questionId).first();
  if (!q) return c.json({ error: 'not_found' }, 404);
  if (!q.retired_at) return c.json({ error: 'not_retired', message: '这道题没有停用' }, 409);
  await c.env.DB.prepare(
    'UPDATE questions SET retired_at = NULL, retired_by = NULL WHERE question_id = ? AND retired_at IS NOT NULL'
  ).bind(questionId).run();
  const after = await c.env.DB.prepare('SELECT status, retired_at FROM questions WHERE question_id = ?')
    .bind(questionId).first();
  return c.json({ ok: true, ...after });
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

// 考点标签库：只给这一章所属学科的（校对页的候选列表）。
//
// 以前所有学科的考点一起返回，校对生化题时候选里混着英语的"动词时态"，选错了不报错，
// 生化题就挂上了英语的考点。学科按这一章的课程认定，不让页面自己传：页面传错了，
// 候选列表和保存时用的学科（题目自己的 subject_id）就对不上。
bankRouter.get('/knowledge-points', async (c) => {
  const examId = c.req.query('examId');
  if (!examId) {
    return c.json({ error: 'exam_required', message: '要带上 examId：考点按学科分开，得知道是给哪一章选' }, 400);
  }
  const subject = await c.env.DB.prepare(
    `SELECT s.subject_id, s.code, s.name
       FROM exams e JOIN courses co ON co.course_code = e.course_code
       LEFT JOIN subjects s ON s.subject_id = co.subject_id
      WHERE e.exam_id = ?`
  ).bind(examId).first();
  if (!subject) return c.json({ error: 'not_found' }, 404);
  // 课程没挂学科就说不清该列哪一科的，不回落成"全部列出来"——那正是要修的毛病
  if (subject.subject_id === null) {
    return c.json({ error: 'course_without_subject', message: `${examId} 所属的课程没有挂学科，列不出考点` }, 422);
  }
  // 备选只列本学科**有题挂着**的考点（用户 2026-10-03：考点由题库里的题产生），按出现次数从高到低。
  // 没有题挂着的不列：生化的章名"蛋白质化学"是给子考点挂的，题都挂在子考点上；AI 起的名字
  // 在校对时被换掉以后就没有题了，也不该再出现在备选里。
  // exam_count = 这一章有几道挂着它，界面拿它分"这一章用到的"和"本学科其他的"。
  const { results } = await c.env.DB.prepare(
    `SELECT k.tag_id, k.name, COUNT(*) AS question_count,
            SUM(CASE WHEN q.exam_id = ? THEN 1 ELSE 0 END) AS exam_count
     FROM knowledge_points k
     JOIN question_knowledge_points x ON x.tag_id = k.tag_id
     JOIN questions q ON q.question_id = x.question_id
     WHERE k.subject_id = ?
     GROUP BY k.tag_id, k.name ORDER BY question_count DESC, k.name`
  ).bind(examId, subject.subject_id).all();
  return c.json({ subject: { code: subject.code, name: subject.name }, knowledgePoints: results });
});
