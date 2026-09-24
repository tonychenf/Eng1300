import { Hono } from 'hono';
import { validateAssets } from '../lib/stem-assets.js';
import { ANSWER_CONFIRMED, isAnswerState, isAnswerSource } from '../lib/pickable.js';
import { shapeContentGroup, ORDER_BY_RECENT } from '../lib/content-group.js';
import { inputGroupsWithoutAnswer } from '../lib/question-items.js';

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

  // §6.4.10：缺答案题数按学科分开数——它是内容建设进度，混在一起看不出哪一科卡着。
  const { results: answers } = await c.env.DB.prepare(
    `SELECT s.code AS subject_code, s.name AS subject_name,
            SUM(CASE WHEN q.answer_state = '缺答案' THEN 1 ELSE 0 END) AS no_answer,
            SUM(CASE WHEN q.answer_state = '待核' THEN 1 ELSE 0 END) AS unreviewed,
            SUM(CASE WHEN q.answer_state = '已确认' THEN 1 ELSE 0 END) AS confirmed
       FROM questions q JOIN subjects s ON s.subject_id = q.subject_id
      GROUP BY s.subject_id ORDER BY s.sort_order, s.subject_id`
  ).all();

  return c.json({ byCourse, byType, byTag, byAnswerState: answers, unresolvedNotes: pending?.n || 0 });
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

  const shaped = sections.map((s) => ({
    ...s,
    questions: questions
      .filter((q) => q.section_id === s.section_id)
      .map((q) => ({
        ...q,
        options: q.options ? JSON.parse(q.options) : null,
        knowledgePoints: q.tag_names ? q.tag_names.split('||') : [],
        items: itemsBy.get(q.question_id) || [],
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

  if (fields.length) {
    binds.push(questionId);
    await c.env.DB.prepare(`UPDATE questions SET ${fields.join(', ')} WHERE question_id = ?`)
      .bind(...binds).run();
  }

  for (const [col, val, ord] of itemWrites) {
    await c.env.DB.prepare(
      `UPDATE question_items SET ${col} = ? WHERE question_id = ? AND item_ord = ?`
    ).bind(val, questionId, ord).run();
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

  // N3：题型的 CHECK 从表上去掉了（题型由学科声明），校验挪到这里。
  // 发布是"这道题从此会被抽给学员"的那一刻，也是最后一道关：题型没在该学科
  // 声明过的话，判分时 pack.typeOf 会抛错，学员看到的是一次失败的交卷。
  // 在这里拦住，并且把是哪几道题、什么题型说出来——CHECK 只会给一句约束失败。
  const { results: badTypes } = await c.env.DB.prepare(
    `SELECT q.question_id, q.ord, q.question_type
       FROM questions q
      WHERE q.exam_id = ? AND q.status != '存疑'
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
      WHERE q.exam_id = ? AND q.status != '存疑'
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
      WHERE q.exam_id = ? AND q.status != '存疑' AND q.answer_state = ?
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

  // N6（§6.4.10、B14）：答案没确认的题扣下不发。
  //
  // 为什么是扣下而不是整卷拒绝：分章上线是明确允许的（§12 的风险条目——
  // 核完一章发一章），而生化一章 34 道题不可能同时核完。存疑的题本来就是这么处理的。
  // 但**扣下必须说出来**：界面上看到"已发布"而实际只发了 30/34，
  // 又没有任何地方提示，那是最糟的一种"成功"。
  const { results: noAnswer } = await c.env.DB.prepare(
    `SELECT question_id, ord, answer_state FROM questions
      WHERE exam_id = ? AND status != '存疑' AND answer_state <> ?
      ORDER BY ord`
  ).bind(examId, ANSWER_CONFIRMED).all();

  // 标记为存疑、以及答案未确认的题目不随整卷发布
  await c.env.DB.prepare(
    `UPDATE questions SET status = '已发布'
      WHERE exam_id = ? AND status != '存疑' AND answer_state = ?`
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
