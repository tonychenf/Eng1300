// 后台上传原始资料，在 Worker 里跑导入管线，只留解析结果（§6.4.3、N6b）。
//
// 三条贯穿整个文件的规矩：
//
// ① **原件不落盘。** request body 从头到尾只在内存里过一遍，解析完就没了。
//    留下来的是抽出来的段落纯文本（content_group_sources）。代价是解析器改进之后
//    没法重跑，要重来只能请人再传一次——这是用户明确选的。
//
// ② **拿不准就拒，不猜。** 学科有几门课、题型有没有声明、内容组 id 撞没撞，
//    每一条都当场回 4xx 并说清楚是什么。猜一个填进去的后果是题入了库、
//    发布时才被拒，而那时报错指向一个看起来毫无关系的地方。
//
// ③ **上传的内容组带 origin='UPLOAD'。** 种子导入只清自己的（见 build-seed-sql.mjs），
//    不打这个标记的话，下一次部署会把这一章连同已录的答案一起清掉。
import { Hono } from 'hono';
import { resolvePipeline } from '../import/index.js';
import { ITEM_KINDS } from '../lib/question-items.js';
import { resolveSettings } from '../lib/ai.js';
import { purposeForMedia, purposeMeta } from '../lib/ai-purposes.js';
import { generateAnswers, targetItems } from '../lib/ai-answer.js';

export const importRouter = new Hono();

// 内容组 id 进 URL、进文件名、进主键，收窄到一眼能看懂的字符集。
const GROUP_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;
// Worker 单次请求的 CPU 时间有上限，解压加解析都在这个预算里。
// 一章 docx 通常几十到几百 KB；给到 10MB 已经很宽，超了多半是传错了文件。
const MAX_BYTES = 10 * 1024 * 1024;
// D1 一批语句的条数上限没有明文保证，分批发，不赌。
const BATCH = 40;

const bad = (c, status, error, message, extra = {}) =>
  c.json({ error, message, ...extra }, status);

importRouter.post('/import', async (c) => {
  const me = c.get('user');
  const db = c.env.DB;
  const subjectCode = (c.req.query('subjectCode') || '').trim();
  const groupId = (c.req.query('groupId') || '').trim();
  const label = (c.req.query('label') || '').trim();
  const filename = (c.req.query('filename') || '').trim() || null;
  const dryRun = c.req.query('dryRun') === '1';
  const orderKey = Number(c.req.query('orderKey'));

  if (!subjectCode) return bad(c, 400, 'invalid_request', '缺少 subjectCode');
  if (!GROUP_ID_RE.test(groupId)) {
    return bad(c, 400, 'invalid_group_id',
      `内容组 id 需为小写字母开头、2-64 位的小写字母/数字/连字符，收到 ${JSON.stringify(groupId)}`);
  }
  if (!label) return bad(c, 400, 'invalid_request', '缺少 label（内容组的显示名）');
  // order_key 是内容组之间唯一的结构性字段（§6.4.2）。**不给默认值**：
  // 回落成 0 的话这一组会静默排到所有内容组的最前面，而排序错了不报错。
  if (!Number.isInteger(orderKey)) {
    return bad(c, 400, 'invalid_order_key',
      `缺少 orderKey（排序依据，生化按章节号），收到 ${JSON.stringify(c.req.query('orderKey'))}`);
  }

  const subject = await db.prepare('SELECT * FROM subjects WHERE code = ?').bind(subjectCode).first();
  if (!subject) return bad(c, 404, 'subject_not_found', `没有学科 ${subjectCode}`);
  if (subject.status !== '启用') {
    return bad(c, 422, 'subject_disabled', `学科「${subject.name}」已停用，不能往里导内容`);
  }

  let pipeline;
  try {
    pipeline = resolvePipeline(subject.ingest_pipeline);
  } catch (e) {
    return bad(c, 422, e.code || 'pipeline_not_implemented',
      `学科「${subject.name}」声明的导入管线是 ${subject.ingest_pipeline}，${e.message}`);
  }

  // 课程是题目的挂载点。一个学科有多门课时**必须点名**，不替人挑——
  // 挑错了的后果是题挂到另一门课下面，界面上看不出来，抽题时才发现少了一批。
  const { results: courses } = await db.prepare(
    'SELECT course_code, course_name FROM courses WHERE subject_id = ? ORDER BY course_code'
  ).bind(subject.subject_id).all();
  if (!courses.length) {
    return bad(c, 422, 'no_course_for_subject', `学科「${subject.name}」名下还没有课程，题没有地方挂`);
  }
  const wantCourse = (c.req.query('courseCode') || '').trim();
  let courseCode = courses[0].course_code;
  if (courses.length > 1 || wantCourse) {
    const hit = courses.find((x) => x.course_code === wantCourse);
    if (!hit) {
      return bad(c, 400, 'course_required',
        `学科「${subject.name}」名下有 ${courses.length} 门课，请用 courseCode 指定一门`,
        { courses });
    }
    courseCode = hit.course_code;
  }

  const existing = await db.prepare('SELECT exam_id, origin, label FROM exams WHERE exam_id = ?')
    .bind(groupId).first();
  if (existing) {
    // 默认拒绝覆盖。覆盖会连带清掉这一章已录的答案与学生的作答记录，
    // 这件事不该由一次手滑决定，也不该在上传接口里顺手做。
    // 提示里只说真能做到的事：删除在校对页，而且只删得掉没发布、没人做过的上传内容组
    // （见下面的 DELETE）。以前这里叫人"在后台删除"，后台其实没有这个功能。
    return bad(c, 409, 'group_exists',
      `内容组 ${groupId}（${existing.label}）已经存在，来源是 ${existing.origin}。` +
      (existing.origin === 'UPLOAD'
        ? '要重传，先到它的校对页点「删除内容组」（只能删没发布、没有学员做过的），或者换一个内容组 id。'
        : '它来自仓库里的种子文件，后台删不了；请换一个内容组 id。'));
  }

  const body = await c.req.arrayBuffer();
  if (!body || body.byteLength === 0) return bad(c, 400, 'empty_body', '没有收到文件内容');
  if (body.byteLength > MAX_BYTES) {
    return bad(c, 413, 'file_too_large',
      `文件 ${(body.byteLength / 1048576).toFixed(1)}MB，超过上限 ${MAX_BYTES / 1048576}MB`);
  }

  let parsed;
  try {
    parsed = await pipeline.run(body, {
      subjectCode, courseCode, groupId, chapterNo: orderKey, label,
    });
  } catch (e) {
    // 解析失败一律 422 带上原始错误码（bad_zip / bad_source / unsupported_numbering…）。
    // 这些都是"你传的文件不对"或"这份排版我读不了"，不是服务器故障，
    // 回 500 对上传的人没有任何帮助。
    return bad(c, 422, e.code || 'parse_failed', e.message || String(e));
  }

  const group = parsed.group;
  const allQ = group.sections.flatMap((s) => s.questions);
  if (!allQ.length) return bad(c, 422, 'no_questions', '这份文件里一道题都没解析出来');

  // 题型必须是本学科声明过的，否则这一章永远发布不了（发布门会拒）。
  // 在上传这一刻说，比等录完答案点发布时才说有用得多。
  const { results: declared } = await db.prepare(
    'SELECT type_code FROM subject_question_types WHERE subject_id = ?'
  ).bind(subject.subject_id).all();
  const declaredSet = new Set(declared.map((x) => x.type_code));
  const badTypes = [...new Set(allQ.map((q) => q.questionType))].filter((t) => !declaredSet.has(t));
  if (badTypes.length) {
    return bad(c, 422, 'question_type_not_declared',
      `这些题型没在学科「${subject.name}」声明过：${badTypes.join('、')}（已声明 ` +
      `${[...declaredSet].join('、') || '（无）'}）`);
  }
  const badKinds = allQ.flatMap((q) => (q.items || []).map((it) => it.kind))
    .filter((k) => !ITEM_KINDS.includes(k));
  if (badKinds.length) {
    return bad(c, 422, 'bad_item_kind', `解析出了不认识的得分单元类型：${[...new Set(badKinds)].join('、')}`);
  }

  // 没有考点的题进不了练习（按考点抽题）。这不拦，但要说——
  // 录完答案发布了却抽不到，比上传时被拒更难查。
  const noTags = allQ.filter((q) => !(q.knowledgePoints || []).length).length;

  const summary = {
    subjectCode, courseCode, groupId, label, orderKey,
    questions: parsed.stats.questions,
    blanks: parsed.stats.blanks,
    paragraphs: parsed.stats.paragraphs,
    perSection: parsed.stats.perSection,
    parsingNotes: group.parsingNotes,
    questionsWithoutTags: noTags,
    answerState: group.answerState,
  };
  if (dryRun) return c.json({ ok: true, dryRun: true, ...summary });

  // ---- 落库 ----
  const st = [];
  const meName = me?.username || `user:${me?.id ?? '?'}`;
  st.push(db.prepare(
    `INSERT INTO exams (exam_id, course_code, title, label, order_key, meta, year, month,
                        source_file, status, origin)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, '待校对', 'UPLOAD')`
  ).bind(groupId, courseCode, label, label, orderKey,
    JSON.stringify({ chapterNo: orderKey, groupKind: group.groupKind ?? null }), filename));

  for (const s of group.sections) {
    st.push(db.prepare(
      'INSERT INTO sections (section_id, exam_id, type, ord) VALUES (?, ?, ?, ?)'
    ).bind(s.sectionId, groupId, s.type, s.order));
    for (const qu of s.questions) {
      st.push(db.prepare(
        `INSERT INTO questions (question_id, section_id, exam_id, course_code, section_type, ord,
                                question_type, stem, options, status,
                                answer_state, answer_source, subject_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`
      ).bind(qu.questionId, s.sectionId, groupId, courseCode, s.type, qu.order,
        qu.questionType, qu.stem, qu.options ? JSON.stringify(qu.options) : null,
        qu.status || '草稿', qu.answerState || group.answerState || '缺答案',
        subject.subject_id));
      for (const it of qu.items || []) {
        st.push(db.prepare(
          `INSERT INTO question_items (question_id, item_ord, subject_id, item_kind, weight)
           VALUES (?, ?, ?, ?, 1)`
        ).bind(qu.questionId, it.ord, subject.subject_id, it.kind));
      }
    }
  }
  for (const nt of group.parsingNotes || []) {
    st.push(db.prepare(
      `INSERT INTO exam_parsing_notes (exam_id, note, note_kind, corrected_from, corrected_to,
                                       corrected_by, corrected_at)
       VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)`
    ).bind(groupId, nt.note, nt.kind || '解析存疑', nt.correctedFrom ?? null,
      nt.correctedTo ?? null, nt.correctedBy ?? null, nt.correctedFrom ?? null));
  }
  // 纯文本留存。**原件到这里就丢了**——它只在上面那个 arrayBuffer 里存在过。
  st.push(db.prepare(
    `INSERT INTO content_group_sources (exam_id, filename, byte_size, pipeline, paragraphs, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(groupId, filename, body.byteLength, subject.ingest_pipeline,
    JSON.stringify(parsed.paragraphs || []), meName));

  for (let i = 0; i < st.length; i += BATCH) {
    await db.batch(st.slice(i, i + BATCH));
  }

  return c.json({ ok: true, dryRun: false, ...summary, statements: st.length });
});

// 给上传进来的题生成候选答案（§6.4.10 的"可选的 AI 辅助"）。
//
// 单开一个接口、不塞进上传那一步：34 道题 × 3-4 秒、并发 5 也要二十几秒，
// 和解压解析挤在同一个请求里会顶到 Worker 的时长上限；分开之后失败几道就重跑几道，
// 不用把整章重传。界面上仍然是"传完自动接着跑"，对使用者是一件事。
importRouter.post('/exams/:examId/ai-answers', async (c) => {
  const db = c.env.DB;
  const examId = c.req.param('examId');
  const exam = await db.prepare('SELECT * FROM exams WHERE exam_id = ?').bind(examId).first();
  if (!exam) return bad(c, 404, 'not_found', `没有内容组 ${examId}`);
  // 只给后台上传的内容组生成。种子导入的那些一旦种子文件变了就会重新导入，
  // 写在上面的 AI 答案会被冲掉——而冲掉是静默的，人不会知道自己核过的东西没了。
  if (exam.origin !== 'UPLOAD') {
    return bad(c, 422, 'not_uploaded',
      `内容组 ${examId} 来自${exam.origin === 'SEED' ? '仓库里的种子文件' : '未知来源'}，` +
      '不在这里补答案：种子一变就会重新导入，写上去的答案会被静默冲掉。');
  }

  const subject = await db.prepare('SELECT * FROM subjects WHERE subject_id = ?')
    .bind(exam.subject_id ?? -1).first()
    || await db.prepare(
      'SELECT s.* FROM subjects s JOIN courses co ON co.subject_id = s.subject_id WHERE co.course_code = ?'
    ).bind(exam.course_code).first();
  if (!subject) return bad(c, 422, 'subject_not_found', '这个内容组挂不到任何学科上');

  // 原始资料是图片还是文字，决定用哪一档 AI 配置（§6.4.3、N7d）。
  // 管线自己声明 mediaKind，这里不按学科硬判——同一个学科将来既有扫描件又有 docx 时，
  // 按学科判就说不清该用哪一档。
  let mediaKind = 'text';
  try { mediaKind = resolvePipeline(subject.ingest_pipeline)?.mediaKind || 'text'; } catch { /* 管线没实现也不影响补答案 */ }
  const wantPurpose = purposeForMedia(mediaKind);
  const settings = await resolveSettings(c.env, wantPurpose);
  if (!settings) {
    const meta = purposeMeta(wantPurpose);
    return bad(c, 422, 'ai_not_configured',
      `还没有配置「${meta?.label || wantPurpose}」。去后台「AI 配置」里填接口地址、模型与 Key` +
      '（三项都可自由填写）。');
  }

  const { results: rows } = await db.prepare(
    `SELECT question_id, ord, question_type, stem, options
       FROM questions WHERE exam_id = ? AND answer_state = '缺答案' ORDER BY ord`
  ).bind(examId).all();
  if (!rows.length) {
    return c.json({ ok: true, generated: 0, failures: [], message: '这一章没有缺答案的题' });
  }
  const { results: itemRows } = await db.prepare(
    `SELECT i.question_id, i.item_ord, i.item_kind FROM question_items i
       JOIN questions q ON q.question_id = i.question_id
      WHERE q.exam_id = ? ORDER BY i.question_id, i.item_ord`
  ).bind(examId).all();
  const itemsBy = new Map();
  for (const r of itemRows) {
    if (!itemsBy.has(r.question_id)) itemsBy.set(r.question_id, []);
    itemsBy.get(r.question_id).push({ ord: r.item_ord, kind: r.item_kind });
  }
  const questions = rows.map((r) => ({
    questionId: r.question_id,
    ord: r.ord,
    questionType: r.question_type,
    stem: r.stem,
    options: (() => { try { return r.options ? JSON.parse(r.options) : null; } catch { return null; } })(),
    items: itemsBy.get(r.question_id) || [],
  }));

  const prompt = await db.prepare(
    `SELECT * FROM subject_ai_prompts WHERE feature = 'answer_generate' AND subject_id IN (?, 0)
      ORDER BY subject_id DESC LIMIT 1`
  ).bind(subject.subject_id).first();

  // 本学科已有的考点名，带进提示里让 AI 优先照抄（ai-answer.js 的 kpRule）。按出现次数从高到低，
  // 最多 200 个，免得提示越来越长。只要子考点：生化的章名"蛋白质化学"下面挂着子考点，题不挂它。
  // AI 起过、后来在校对时被换掉的（kp-ai- 开头、已经没有题挂着）不再递给它，免得被人否掉的名字又回来。
  const { results: kpRows } = await db.prepare(
    `SELECT k.name, COUNT(x.question_id) AS n
       FROM knowledge_points k LEFT JOIN question_knowledge_points x ON x.tag_id = k.tag_id
      WHERE k.subject_id = ?
        AND NOT EXISTS (SELECT 1 FROM knowledge_points ch WHERE ch.parent_tag_id = k.tag_id)
      GROUP BY k.tag_id
     HAVING n > 0 OR substr(k.tag_id, 1, 6) <> 'kp-ai-'
      ORDER BY n DESC, k.sort_order, k.name
      LIMIT 200`
  ).bind(subject.subject_id).all();
  const kpNames = kpRows.map((r) => r.name);

  const { generated, failures, withoutExplanation, withoutKnowledgePoints } = await generateAnswers(c.env, {
    questions, subjectId: subject.subject_id, prompt, purpose: wantPurpose, kpNames,
  });

  // 落库：一律 待核 + 来源 AI。**绝不自动发布**（§6.4.10 的硬约束）。
  const byId = new Map(questions.map((q) => [q.questionId, q]));
  const st = [];
  for (const g of generated) {
    // 解析为空时**不要覆盖**已有的 answer_explanation：校对时人工写过一段，
    // 重跑一次 AI 就把它抹掉，属于"这次失败改变了用户要的结果"。
    if (g.explanation) {
      st.push(db.prepare(
        `UPDATE questions SET answer = ?, answer_explanation = ?, answer_state = '待核',
                answer_source = 'AI', answer_reviewed_by = NULL, answer_reviewed_at = NULL
          WHERE question_id = ?`
      ).bind(g.answer, g.explanation, g.questionId));
    } else {
      st.push(db.prepare(
        `UPDATE questions SET answer = ?, answer_state = '待核', answer_source = 'AI',
                answer_reviewed_by = NULL, answer_reviewed_at = NULL
          WHERE question_id = ?`
      ).bind(g.answer, g.questionId));
    }
    if (g.items) {
      const targets = targetItems(byId.get(g.questionId));
      g.items.forEach((val, i) => {
        if (!targets[i]) return;
        st.push(db.prepare(
          'UPDATE question_items SET answer = ? WHERE question_id = ? AND item_ord = ?'
        ).bind(val, g.questionId, targets[i].ord));
      });
    }
  }
  for (let i = 0; i < st.length; i += BATCH) await db.batch(st.slice(i, i + BATCH));

  // 考点：挂到题上（只加不删——管理员先手动挂过的留着），和 AI 答案一样等人校对：
  // 题目答案没确认就发布不了，学员那边抽不到。按"学科 + 名字"找，没有就在这个学科下新建，
  // 编号带 kp-ai- 前缀——删这一章时据此清掉它带进来、已经没人用的考点。
  // 挂考点那句按名字现查编号，不拿这里生成的编号：同名的考点早就在库里时，新建那句被忽略，
  // 照生成的编号挂就会外键报错。
  // 考点存不进去不让整件事失败（答案已经落库了），但要报出来，不能悄悄没了。分批写的，前几批可能已经进去了，
  // 所以失败时几道带上了考点是"不知道"（null），不报 0——0 是合法结果，回落成 0 等于把不知道说成一道都没有。
  const kpWanted = generated.filter((g) => g.knowledgePoints?.length);
  const known = new Set(kpNames);
  const newNames = [...new Set(kpWanted.flatMap((g) => g.knowledgePoints))].filter((n) => !known.has(n));
  let knowledgePointsFailed = null;
  let createdNames = [];
  if (kpWanted.length) {
    const { results: existing } = await db.prepare('SELECT name FROM knowledge_points WHERE subject_id = ?')
      .bind(subject.subject_id).all();
    const inSubject = new Set(existing.map((r) => r.name));
    createdNames = newNames.filter((n) => !inSubject.has(n));
    const kst = createdNames.map((name) => db.prepare(
      'INSERT OR IGNORE INTO knowledge_points (tag_id, name, subject_id) VALUES (?, ?, ?)'
    ).bind(`kp-ai-${crypto.randomUUID().slice(0, 8)}`, name, subject.subject_id));
    for (const g of kpWanted) {
      for (const name of g.knowledgePoints) {
        kst.push(db.prepare(
          `INSERT OR IGNORE INTO question_knowledge_points (question_id, tag_id)
           SELECT ?, tag_id FROM knowledge_points WHERE subject_id = ? AND name = ?`
        ).bind(g.questionId, subject.subject_id, name));
      }
    }
    try {
      for (let i = 0; i < kst.length; i += BATCH) await db.batch(kst.slice(i, i + BATCH));
    } catch (e) {
      knowledgePointsFailed = String(e.message || e).slice(0, 200);
    }
  }

  return c.json({
    ok: true,
    generated: generated.length,
    attempted: questions.length,
    failures,
    // 用的是哪一档配置要报出来。回落时（比如没配文字解析、沿用了图片解析那档）
    // 管理员以为在用自己配的模型，而时延、账单、效果都来自另一个——三者对不上又没线索。
    mediaKind,
    purpose: settings._usedPurpose || wantPurpose,
    purposeFellBack: Boolean(settings._fallback),
    withoutExplanation,
    withKnowledgePoints: knowledgePointsFailed ? null : kpWanted.length,
    withoutKnowledgePoints,
    newKnowledgePoints: knowledgePointsFailed ? null : createdNames,
    knowledgePointsFailed,
    // 说清楚这些答案还不能用。界面上要显眼——"AI 生成完了"很容易被读成"可以发布了"。
    message: `生成了 ${generated.length} 道的候选答案，全部落在「待核」——` +
      `逐题人工确认之后才能发布。` +
      (failures.length ? `另有 ${failures.length} 道没生成出来，仍是缺答案。` : '') +
      (withoutExplanation.length ? `其中 ${withoutExplanation.length} 道只有答案、没有解析。` : '') +
      (knowledgePointsFailed
        ? `考点存的时候出错了（${knowledgePointsFailed}），可能只存进去一部分，校对时逐题看一眼。`
        : (kpWanted.length ? `${kpWanted.length} 道带上了 AI 给的考点，校对时一并确认。` : '') +
          (withoutKnowledgePoints.length ? `${withoutKnowledgePoints.length} 道没给出能用的考点，校对时从备选里选。` : '')),
  });
});

// 删除一个后台上传的内容组（CR-M4）。
//
// 上传撞了 id 时，上面的 409 叫人先删掉旧的——在这之前后台根本没有删的地方，
// 传错一次文件，这个 id 就一直占着。线上实测（prod-e2e）传完测试章节也靠它收拾。
//
// 三个条件都满足才删，不满足就说清楚为什么，不替人做决定：
// ① 后台上传的（origin='UPLOAD'）。种子导入的归仓库管：删了之后要等种子文件变了才会重导，
//    这期间库和仓库对不上，而且没有任何地方提示。
// ② 没有发布。已发布的学员正在用，先「撤回发布」——删除不顺手替人撤回。
// ③ 没有学员数据引用它的题（作答、答题记录、错题本）。这三张表的外键指着题目，
//    要删题就得连它们一起删，学员的成绩报告和错题本会少一块，
//    这不是"删一章内容"该有的后果。只想让学员看不到，撤回发布就够了。
//
// 删除是一次 db.batch：D1 把一批语句放在一个事务里，中途失败整批回滚，不会删一半。
// 顺序是先子表后父表——外键约束下反过来会在第一句就失败。
importRouter.delete('/exams/:examId', async (c) => {
  const db = c.env.DB;
  const examId = c.req.param('examId');
  const exam = await db.prepare('SELECT exam_id, label, origin, status FROM exams WHERE exam_id = ?')
    .bind(examId).first();
  if (!exam) return bad(c, 404, 'not_found', `没有内容组 ${examId}`);
  const name = `内容组 ${examId}（${exam.label}）`;
  if (exam.origin !== 'UPLOAD') {
    return bad(c, 422, 'not_uploaded',
      `${name}来自${exam.origin === 'SEED' ? '仓库里的种子文件' : '未知来源'}，不在后台删：` +
      '它归仓库管，删了库和仓库就对不上了。只想让学员看不到的话，用「撤回发布」。');
  }
  if (exam.status === '已发布') {
    return bad(c, 409, 'published', `${name}已发布，学员正在用。先「撤回发布」，再删除。`);
  }

  const ofGroup = 'SELECT question_id FROM questions WHERE exam_id = ?';
  const used = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM (
               SELECT attempt_id FROM attempt_questions WHERE question_id IN (${ofGroup})
               UNION
               SELECT attempt_id FROM answer_records WHERE question_id IN (${ofGroup}))) AS attempts,
            (SELECT COUNT(*) FROM wrong_items WHERE question_id IN (${ofGroup})) AS wrong`
  ).bind(examId, examId, examId).first();
  if (used.attempts > 0 || used.wrong > 0) {
    return bad(c, 409, 'in_use',
      `${name}已经有学员做过：${used.attempts} 次作答、${used.wrong} 条错题记录用到了它的题。` +
      '删了会让他们的成绩报告和错题本缺一块，所以不能删；只想让学员看不到的话，用「撤回发布」。',
      { attempts: used.attempts, wrongItems: used.wrong });
  }

  const res = await db.batch([
    db.prepare(`DELETE FROM question_items WHERE question_id IN (${ofGroup})`).bind(examId),
    db.prepare(`DELETE FROM question_assets WHERE question_id IN (${ofGroup})`).bind(examId),
    db.prepare(`DELETE FROM question_knowledge_points WHERE question_id IN (${ofGroup})`).bind(examId),
    db.prepare('DELETE FROM questions WHERE exam_id = ?').bind(examId),
    db.prepare('DELETE FROM sections WHERE exam_id = ?').bind(examId),
    db.prepare('DELETE FROM exam_parsing_notes WHERE exam_id = ?').bind(examId),
    db.prepare('DELETE FROM content_group_sources WHERE exam_id = ?').bind(examId),
    db.prepare('DELETE FROM exams WHERE exam_id = ?').bind(examId),
    // AI 给上传的题起的考点（kp-ai- 开头），题删了就没人用了，一起清掉。只清没有任何题、
    // 掌握度记录挂着、下面也没有子考点的——别的章还在用的留着；种子文件里的、管理员手动建的不动。
    // 必须排在删题目-考点那句后面。substr 比前缀，不用 LIKE（下划线是 LIKE 的通配符）。
    db.prepare(`DELETE FROM knowledge_points
      WHERE substr(tag_id, 1, 6) = 'kp-ai-'
        AND tag_id NOT IN (SELECT tag_id FROM question_knowledge_points)
        AND tag_id NOT IN (SELECT tag_id FROM user_knowledge_mastery)
        AND tag_id NOT IN (SELECT parent_tag_id FROM knowledge_points WHERE parent_tag_id IS NOT NULL)`),
  ]);
  // 读不到行数就报 null，不报 0：0 是合法结果（这一章本来就没有图），
  // 回落成 0 等于把"不知道"说成"一行都没有"
  const n = (i) => res[i]?.meta?.changes ?? null;
  return c.json({
    ok: true,
    examId,
    label: exam.label,
    deleted: {
      items: n(0), assets: n(1), knowledgePointLinks: n(2), questions: n(3),
      sections: n(4), parsingNotes: n(5), sources: n(6), aiKnowledgePoints: n(8),
    },
  });
});

// 某个内容组的原文段落，校对页对照用。原件已经丢了，这是唯一能对的东西。
importRouter.get('/import/:examId/source', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT * FROM content_group_sources WHERE exam_id = ?'
  ).bind(c.req.param('examId')).first();
  if (!row) return c.json({ error: 'not_found', message: '这个内容组不是后台上传的，没有留存原文' }, 404);
  let paragraphs = [];
  try { paragraphs = JSON.parse(row.paragraphs); } catch { paragraphs = []; }
  return c.json({
    examId: row.exam_id,
    filename: row.filename,
    byteSize: row.byte_size,
    pipeline: row.pipeline,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
    paragraphs,
  });
});
