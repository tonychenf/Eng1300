// 后台上传题库文件（改进阶段 2 P1-I1，ingest_pipeline = 'json-direct'）。
//
// 文件就是 data/subjects/*/groups/*.json 那种格式（种子生成器读的就是它）。第三期 AI 拆题上线之前，
// 新课的题库文件由 Claude 照资料生成、管理员在后台传——省掉的是"改代码、走 PR、部署"这一步。
//
// 和种子导入的区别：
//   - 编号重写：内容组、大题、题目编号一律按本次导入重新起（P1-A5 的规则）。文件里原来的编号是给仓库那个学科用的，
//     原样落库的话，把公共英语的文件传进"公共英语副本"就会和公共英语自己的题撞主键；
//   - 课程按上传的学科定，不认文件里的 courseCode；
//   - 考点按"学科 + 名字"找，找不到在这个学科下新建（编号 kp-up- 开头），不读 knowledge-points.json；
//   - 题干带图的不收：图要跟着文件一起进仓库（data/subjects/*/assets），后台传不了图。
//   - origin = 'UPLOAD'：和 Word 上传一样，没发布、没人做过时可以整组删除重来。
import { ITEM_KINDS } from '../lib/question-items.js';
import { flaggedOrders, normalizeNote, contentGroupOf, answerStateOf } from './group-file.js';

function bad(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function sha8(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 读文件、校验，算出要写的语句。dryRun 时调用方只看 summary。出错抛带 code 的错误（调用方回 422）。 */
// 常见的"传错了"：手机上选文件时 accept=".json" 拦不住相册，照片、PDF、Word 都会被传上来。
// 按文件开头几个字节认出来，用人话说清楚，不把 JSON 解析器的报错（一串乱码）甩给管理员。
const MAGIC = [
  { kind: '照片（JPEG）', test: (b) => b[0] === 0xff && b[1] === 0xd8 },
  { kind: '图片（PNG）', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { kind: '照片（HEIC）', test: (b) => String.fromCharCode(...b.slice(4, 12)).startsWith('ftyphei') },
  { kind: 'PDF', test: (b) => String.fromCharCode(...b.slice(0, 4)) === '%PDF' },
  { kind: 'Word 文档或压缩包', test: (b) => b[0] === 0x50 && b[1] === 0x4b },
];
export function wrongFileKind(bytes) {
  const b = new Uint8Array(bytes.slice ? bytes.slice(0, 16) : bytes);
  return MAGIC.find((m) => m.test(b))?.kind || null;
}

export async function planGroupImport(db, { subject, courseCode, bytes, groupId, label, orderKey, filename, uploadedBy }) {
  const kind = wrongFileKind(bytes);
  if (kind) {
    throw bad('wrong_file_type',
      `传上来的是${kind}，这门课现在只收题库文件（.json）。照片、PDF 直接识别成题目要等第三期；` +
      '在那之前，把资料发给 Claude，生成题库文件后再传。');
  }
  let d;
  try {
    d = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    throw bad('bad_json', `文件不是合法的 JSON：${String(e.message).slice(0, 120)}`);
  }
  if (!d || typeof d !== 'object' || !Array.isArray(d.sections)) {
    throw bad('bad_group_file', `文件的形状不对：顶层键是 ${Object.keys(d || {}).join(',') || '（空）'}，应当有 sections 数组`);
  }
  // 文件自己的身份信息只拿来取显示名和校验（label、orderKey 能不能算出来）；编号按本次导入重写
  const fileGroup = contentGroupOf({ ...d, orderKey: Number.isInteger(d.orderKey) ? d.orderKey : orderKey }, filename || '上传的文件');
  const flagged = flaggedOrders(d);

  const { results: declared } = await db.prepare(
    'SELECT type_code FROM subject_question_types WHERE subject_id = ?'
  ).bind(subject.subject_id).all();
  const declaredSet = new Set(declared.map((x) => x.type_code));

  const allQ = d.sections.flatMap((s) => s.questions || []);
  if (!allQ.length) throw bad('no_questions', '这份文件里一道题都没有');
  const badTypes = [...new Set(allQ.map((q) => q.questionType))].filter((t) => !declaredSet.has(t));
  if (badTypes.length) {
    throw bad('question_type_not_declared',
      `这些题型没在学科「${subject.name}」声明过：${badTypes.join('、')}（已声明 ${[...declaredSet].join('、') || '（无）'}）`);
  }
  const withAssets = allQ.filter((q) => (q.assets || []).length);
  if (withAssets.length) {
    throw bad('assets_not_supported',
      `有 ${withAssets.length} 道题的题干带图（如 ${withAssets[0].questionId}），后台传不了图片，这种题库文件要随仓库导入`);
  }
  for (const q of allQ) {
    for (const it of q.items || []) {
      if (!ITEM_KINDS.includes(it.kind)) {
        throw bad('bad_item_kind', `题 ${q.questionId} 的得分单元 #${it.ord} 的 kind 是 ${JSON.stringify(it.kind)}，只认 ${ITEM_KINDS.join('、')}`);
      }
    }
  }

  const st = [];
  const useLabel = label || fileGroup.label;
  st.push(db.prepare(
    `INSERT INTO exams (exam_id, course_code, title, label, order_key, meta, year, month, source_file, status, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '待校对', 'UPLOAD')`
  ).bind(groupId, courseCode, useLabel, useLabel, orderKey, fileGroup.meta, fileGroup.year, fileGroup.month, filename));

  // 考点：同一学科里同名就是同一个考点（库里 (subject_id, name) 唯一）。按路径写的（"章/点"）取最后一段。
  const { results: kpRows } = await db.prepare('SELECT tag_id, name FROM knowledge_points WHERE subject_id = ?')
    .bind(subject.subject_id).all();
  const kpByName = new Map(kpRows.map((r) => [r.name, r.tag_id]));
  const newKps = [];

  let confirmed = 0;
  let unconfirmed = 0;
  let qn = 0;
  const perSection = [];
  for (const [si, s] of d.sections.entries()) {
    const sectionId = `${groupId}-s${si + 1}`;
    st.push(db.prepare(
      `INSERT INTO sections (section_id, exam_id, type, ord, passage_title, passage_text, writing_prompt,
                             score_per_question, total_score)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(sectionId, groupId, s.type, s.order ?? si + 1, s.passageTitle ?? null, s.passageText ?? null,
      s.writingPrompt ?? null, s.scorePerQuestion ?? null, s.totalScore ?? null));
    perSection.push({ type: s.type, questions: (s.questions || []).length });
    for (const qu of s.questions || []) {
      qn++;
      const questionId = `${groupId}-q${String(qn).padStart(3, '0')}`;
      const a = answerStateOf(d, qu, filename || '上传的文件');
      if (a.state === '已确认') confirmed++; else unconfirmed++;
      st.push(db.prepare(
        `INSERT INTO questions (question_id, section_id, exam_id, course_code, section_type, ord, question_type, stem,
                                options, answer, answer_explanation, difficulty_tag, status,
                                answer_state, answer_source, answer_reviewed_by, answer_reviewed_at, subject_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(questionId, sectionId, groupId, courseCode, s.type, qu.order ?? qn, qu.questionType, qu.stem ?? null,
        qu.options ? JSON.stringify(qu.options) : null, qu.answer ?? null, qu.answerExplanation ?? null,
        qu.difficultyTag ?? null, flagged.has(qu.order) ? '存疑' : '草稿',
        a.state, a.source, a.by, a.at, subject.subject_id));
      for (const it of qu.items || []) {
        st.push(db.prepare(
          `INSERT INTO question_items (question_id, item_ord, subject_id, item_kind, grading_strategy, group_key,
                                       answer, alt_answers, weight, params)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(questionId, it.ord, subject.subject_id, it.kind, it.strategy ?? null, it.groupKey ?? null,
          it.answer ?? null, it.altAnswers ? JSON.stringify(it.altAnswers) : null, it.weight ?? 1,
          it.params ? JSON.stringify(it.params) : null));
      }
      for (const raw of qu.knowledgePoints || []) {
        const name = String(raw).split('/').pop().trim();
        if (!name) continue;
        let tagId = kpByName.get(name);
        if (!tagId) {
          tagId = `kp-up-${subject.code}-${await sha8(name)}`;
          kpByName.set(name, tagId);
          newKps.push(name);
          st.push(db.prepare(
            'INSERT OR IGNORE INTO knowledge_points (tag_id, name, subject_id, sort_order) VALUES (?, ?, ?, 999)'
          ).bind(tagId, name, subject.subject_id));
        }
        st.push(db.prepare('INSERT OR IGNORE INTO question_knowledge_points (question_id, tag_id) VALUES (?, ?)')
          .bind(questionId, tagId));
      }
    }
  }
  const notes = (d.parsingNotes || []).map(normalizeNote);
  for (const nt of notes) {
    st.push(db.prepare(
      `INSERT INTO exam_parsing_notes (exam_id, note, note_kind, corrected_from, corrected_to, corrected_by, corrected_at)
       VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END)`
    ).bind(groupId, nt.note, nt.kind, nt.correctedFrom, nt.correctedTo, nt.correctedBy, nt.correctedFrom));
  }
  st.push(db.prepare(
    `INSERT INTO content_group_sources (exam_id, filename, byte_size, pipeline, paragraphs, uploaded_by)
     VALUES (?, ?, ?, 'json-direct', '[]', ?)`
  ).bind(groupId, filename, bytes.byteLength, uploadedBy));

  return {
    statements: st,
    summary: {
      groupId, label: useLabel, orderKey, courseCode,
      questions: qn, confirmed, unconfirmed, flagged: flagged.size, perSection,
      newKnowledgePoints: newKps, parsingNotes: notes.length,
    },
  };
}
