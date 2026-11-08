// 开一门新课（改进阶段 2 P1-A1、A2）：一次建学科 + 课程 + 能力包，学员当天就能用。
//
// 以前后台只能建学科行：没有课程、题型、评价标准，能力包读不出来（subject_rubric_missing），
// 上传报"名下还没有课程"——每开一门课都要写迁移、走 PR、部署一次（公共英语就是这么开的）。
//
// 顺序有讲究：**先在内存里验，再写库**。D1 的 batch 提交即生效，写完再读能力包出错是撤不回的；
// 所以把要写的各行在内存里拼成能力包，用读包时的同一套校验（buildPack、validateRubricPayload）先过一遍。
// 写完再真读一次兜底，万一两边不一致（那是要修的 bug），发补偿删除把刚建的删掉。
import { buildPack, loadPack, validateRubricPayload } from './subject-pack.js';
import { SUBJECT_CODE_RE } from './subject.js';
import { auditStmt } from './audit.js';

function bad(code, message, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

// 不参照别的课时给的三种通用题型（拍板 1），定义**照抄生化的同码行**，不另写一套：
// 英语和生化的 fill_text 归一化器不同，统一抄生化那份。
const GENERIC_TYPE_SOURCE = 'biochem';
const GENERIC_TYPES = ['single_choice', 'fill_text', 'short_answer'];

// 不参照时的通用评价标准。按采分点判的题用 0.6 的门槛（PRD 第 12 节决定 6）。
function genericRubric(totalScore) {
  return {
    grading: { partialCredit: true, caseSensitive: false },
    essay: { type: 'POINT_HIT', totalScore: 100, openWeightCap: 0.4, note: '简答题按采分点命中判：得分率 = 命中权重 / 总权重。' },
    mastery: {
      masteredMinTotal: 3, masteredMinStreak: 3, weakRateBelow: 0.5,
      correctThreshold: 1.0, pointCorrectThreshold: 0.6,
      weights: { untested: 2.0, lastWrong: 5.0, byStreak: [{ upTo: 1, weight: 2.0 }, { upTo: 2, weight: 1.0 }, { upTo: null, weight: 0.3 }] },
    },
    passLine: Math.round(totalScore * 0.6),
    fullScore: totalScore,
  };
}

const GENERIC_SCHEMA = [
  { key: 'answerBasis', label: '解析', required: true, widget: 'textarea' },
  { key: 'knowledge', label: '考点', required: false, widget: 'textarea' },
];

/** 默认学科码：s + 两位序号，和已有的不重复。页面上提示"建议改成好记的英文"。 */
export async function suggestSubjectCode(db) {
  const { results } = await db.prepare('SELECT code FROM subjects').all();
  const taken = new Set(results.map((r) => r.code));
  for (let i = results.length + 1; i < results.length + 200; i++) {
    const code = `s${String(i).padStart(2, '0')}`;
    if (!taken.has(code)) return code;
  }
  throw bad('code_exhausted', '想不出一个没被占用的学科码，请手动填一个', 500);
}

function intIn(v, lo, hi, field, label) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`invalid_${field}`, `${label}要是 ${lo}–${hi} 的整数，收到 ${JSON.stringify(v)}`);
  return n;
}

/**
 * @returns {{ subjectId, code, name, courseCode, copiedFrom, copiedPrompts: string[] }}
 * 出错抛带 code / status 的错误，路由原样转成 { error, message }。
 */
export async function createSubjectWithCourse(db, { name, code, copyFrom, totalScore = 100, timeLimitMinutes = 120, actorId }) {
  name = String(name ?? '').trim();
  code = String(code ?? '').trim();
  if (!name) throw bad('name_required', '学科名称不能为空');
  if (name.length > 20) throw bad('name_too_long', '学科名称最多 20 个字');
  if (!SUBJECT_CODE_RE.test(code)) {
    throw bad('invalid_subject_code', '学科码需为 2-20 位小写字母开头，可含小写字母、数字、连字符');
  }
  totalScore = intIn(totalScore, 1, 1000, 'total_score', '满分');
  timeLimitMinutes = intIn(timeLimitMinutes, 10, 600, 'time_limit', '考试时长（分钟）');
  const courseCode = `${code}-main`;

  const dup = await db.batch([
    db.prepare('SELECT code FROM subjects WHERE code = ?').bind(code),
    db.prepare('SELECT code FROM subjects WHERE name = ?').bind(name),
    db.prepare('SELECT course_code FROM courses WHERE course_code = ?').bind(courseCode),
  ]);
  if (dup[0].results.length) throw bad('subject_code_taken', `学科码「${code}」已被占用`, 409);
  if (dup[1].results.length) throw bad('subject_name_taken', `已经有一个叫「${name}」的学科了`, 409);
  if (dup[2].results.length) throw bad('course_code_taken', `课程码「${courseCode}」已被占用，换一个学科码`, 409);

  // ---- 拼出要写的能力包各行 ----
  let typeRows, rubric, schemaFields, promptRows, settingRows, source = null;
  if (copyFrom != null && copyFrom !== '') {
    source = await db.prepare('SELECT subject_id, code, name FROM subjects WHERE subject_id = ? OR code = ?')
      .bind(Number(copyFrom) || -1, String(copyFrom)).first();
    if (!source) throw bad('copy_source_not_found', `要参照的学科「${copyFrom}」不存在`, 404);
    const [t, r, sc, p, st] = await db.batch([
      db.prepare('SELECT * FROM subject_question_types WHERE subject_id = ? ORDER BY sort_order, type_code').bind(source.subject_id),
      db.prepare('SELECT payload FROM subject_rubrics WHERE subject_id = ? AND is_current = 1').bind(source.subject_id),
      db.prepare('SELECT fields FROM subject_explanation_schema WHERE subject_id = ?').bind(source.subject_id),
      db.prepare('SELECT feature, system_prompt, user_template FROM subject_ai_prompts WHERE subject_id = ?').bind(source.subject_id),
      db.prepare('SELECT key, value, description FROM subject_settings WHERE subject_id = ?').bind(source.subject_id),
    ]);
    typeRows = t.results;
    if (!r.results[0]) throw bad('copy_source_broken', `参照的学科「${source.name}」没有生效中的评价标准，复制不了`, 422);
    rubric = JSON.parse(r.results[0].payload);
    rubric.fullScore = totalScore;
    if (rubric.passLine !== undefined) rubric.passLine = Math.round(totalScore * 0.6);
    schemaFields = sc.results[0]?.fields ?? JSON.stringify(GENERIC_SCHEMA);
    // 只做学科名替换。替换不了的学科专有说法判断不了，所以把复制来的几条列出来请管理员看一眼。
    const swap = (txt) => String(txt).split(source.name).join(name);
    promptRows = p.results.map((x) => ({ feature: x.feature, system_prompt: swap(x.system_prompt), user_template: swap(x.user_template) }));
    settingRows = st.results;
  } else {
    const gen = await db.prepare('SELECT subject_id, name FROM subjects WHERE code = ?').bind(GENERIC_TYPE_SOURCE).first();
    if (!gen) throw bad('generic_source_missing', `通用题型照抄自「${GENERIC_TYPE_SOURCE}」学科，库里没有它`, 500);
    const [t, p] = await db.batch([
      db.prepare(`SELECT * FROM subject_question_types WHERE subject_id = ? AND type_code IN (${GENERIC_TYPES.map(() => '?').join(',')})`)
        .bind(gen.subject_id, ...GENERIC_TYPES),
      // 简答要按采分点批：全局默认那份 essay_grade 写的是"学生作文 / 写作要求"，所以抄生化那份
      db.prepare("SELECT feature, system_prompt, user_template FROM subject_ai_prompts WHERE subject_id = ? AND feature = 'essay_grade'")
        .bind(gen.subject_id),
    ]);
    if (t.results.length !== GENERIC_TYPES.length) {
      throw bad('generic_source_missing', `「${gen.name}」里找不全通用题型 ${GENERIC_TYPES.join('、')}`, 500);
    }
    typeRows = t.results;
    rubric = genericRubric(totalScore);
    schemaFields = JSON.stringify(GENERIC_SCHEMA);
    const swap = (txt) => String(txt).split(gen.name).join(name);
    promptRows = p.results.map((x) => ({ feature: x.feature, system_prompt: swap(x.system_prompt), user_template: swap(x.user_template) }));
    settingRows = [];
  }
  // 按采分点判的题要有自己的门槛（读的时候缺了抛错）。参照的学科是旧库、还没补这一项时补上。
  const hasPointTypes = typeRows.some((r) => r.grading_strategy === 'AI_SCORE_POINTS');
  if (hasPointTypes && rubric.mastery && rubric.mastery.pointCorrectThreshold === undefined) {
    rubric.mastery.pointCorrectThreshold = 0.6;
  }

  // ---- 写库前先在内存里验 ----
  const problems = validateRubricPayload(rubric);
  if (problems.length) throw bad('subject_pack_broken', `评价标准不能用：${problems.join('；')}`, 422);
  try {
    buildPack({ subjectId: 0, subj: { code, name }, typeRows, rubricRow: { version: 1, payload: JSON.stringify(rubric) } });
  } catch (e) {
    throw bad('subject_pack_broken', `能力包不能用：${e.message}`, 422);
  }

  // ---- 一个 batch 写进去 ----
  const sid = '(SELECT subject_id FROM subjects WHERE code = ?)';
  const stmts = [
    db.prepare(
      `INSERT INTO subjects (code, name, description, sort_order, content_group_kind, ingest_pipeline)
       VALUES (?, ?, NULL, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM subjects), 'TEXTBOOK_CHAPTER', 'json-direct')`
    ).bind(code, name),
    db.prepare(
      `INSERT INTO courses (course_code, course_name, subject_id, time_limit_minutes, total_score)
       VALUES (?, ?, ${sid}, ?, ?)`
    ).bind(courseCode, name, code, timeLimitMinutes, totalScore),
  ];
  for (const r of typeRows) {
    const cols = Object.keys(r).filter((k) => k !== 'subject_id');
    stmts.push(db.prepare(
      `INSERT INTO subject_question_types (subject_id, ${cols.join(', ')}) VALUES (${sid}, ${cols.map(() => '?').join(', ')})`
    ).bind(code, ...cols.map((k) => r[k])));
  }
  stmts.push(db.prepare(
    `INSERT INTO subject_rubrics (subject_id, version, payload, is_current, created_by) VALUES (${sid}, 1, ?, 1, ?)`
  ).bind(code, JSON.stringify(rubric), actorId ?? null));
  stmts.push(db.prepare(
    `INSERT INTO subject_explanation_schema (subject_id, fields, updated_at) VALUES (${sid}, ?, datetime('now'))`
  ).bind(code, schemaFields));
  for (const p of promptRows) {
    stmts.push(db.prepare(
      `INSERT INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
       VALUES (${sid}, ?, ?, ?, datetime('now'))`
    ).bind(code, p.feature, p.system_prompt, p.user_template));
  }
  for (const s of settingRows) {
    stmts.push(db.prepare(
      `INSERT INTO subject_settings (subject_id, key, value, description) VALUES (${sid}, ?, ?, ?)`
    ).bind(code, s.key, s.value, s.description ?? null));
  }
  stmts.push(auditStmt(db, {
    actorId, action: 'subject.create', target: code,
    after: { code, name, courseCode, totalScore, timeLimitMinutes, copiedFrom: source?.code ?? null },
  }));
  try {
    await db.batch(stmts);
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) throw bad('subject_code_taken', `学科码「${code}」或学科名已被占用`, 409);
    throw e;
  }

  const created = await db.prepare('SELECT subject_id FROM subjects WHERE code = ?').bind(code).first();
  // ---- 兜底：真读一次 ----
  try {
    await loadPack(db, created.subject_id);
  } catch (e) {
    await db.batch(['subject_settings', 'subject_ai_prompts', 'subject_explanation_schema', 'subject_rubrics',
      'subject_question_types', 'courses', 'subjects'].map((t) =>
      db.prepare(`DELETE FROM ${t} WHERE subject_id = ?`).bind(created.subject_id)));
    throw bad('subject_pack_broken',
      `建好之后能力包读不出来，已经撤掉（这说明写库前的校验和读包对不上，是要修的问题）：${e.message}`, 500);
  }

  return {
    subjectId: created.subject_id, code, name, courseCode,
    copiedFrom: source ? { code: source.code, name: source.name } : null,
    copiedPrompts: promptRows.map((p) => p.feature),
  };
}
