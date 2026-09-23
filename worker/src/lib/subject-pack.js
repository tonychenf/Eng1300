// 学科能力包的读取口（需求文档 §5）。
//
// 蓝本把英语的规则写死在六个文件里：判分的拼写表、作文的五维权重、掌握度的阈值、
// 抽题权重、"essay 不进练习"的排除条件、四类 AI 提示词。加第二个学科要改每一处，
// 加第三个再改一遍。这里把它们全搬进数据，代码只剩骨架。
//
// rubric payload 的形状（英语那份是蓝本行为的逐位翻译，改动它就是在改判分）：
//   {
//     grading: { partialCredit, caseSensitive },
//     essay:   { type: 'DIMENSION_WEIGHTED', dimensionMax, totalScore, dimensions: [{key,name,weight,hint}] }
//            | { type: 'POINT_HIT', totalScore, openWeightCap }   // 采分点命中式，判分器 AI_SCORE_POINTS
//            | { type: 'LEVEL_BANDED', totalScore, bands: [{level,name,range,desc}], requireReason }
//     mastery: { masteredMinTotal, masteredMinStreak, weakRateBelow, correctThreshold,
//                weights: { untested, lastWrong, byStreak: [{upTo, weight}] } },
//     passLine
//   }
//
// 取不到就抛错，不回落默认值。回落的后果是：新建的学科没配能力包，却悄悄套用了
// 英语的判分规则和提示词，学生拿到一份"生物化学用英语作文标准打出来的分"，
// 而系统一切正常。
import { resolveNormalizers } from '../normalizers/index.js';
import { resolveGrader, ANSWER_SHAPES } from '../graders/index.js';

function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** 课程 → 学科。既有接口大多只拿得到 courseCode，这里是唯一的换算口。 */
export async function subjectIdOfCourse(db, courseCode) {
  const row = await db.prepare('SELECT subject_id FROM courses WHERE course_code = ?')
    .bind(courseCode).first();
  if (!row) throw fail('course_not_found', `课程 ${courseCode} 不存在`);
  if (row.subject_id == null) {
    throw fail('course_without_subject', `课程 ${courseCode} 还没挂到任何学科上`);
  }
  return row.subject_id;
}

/**
 * 一次把整个包读出来。
 *
 * 一次请求只读一次，读完往下传——判分要对 51 道题逐题调用，每题读一次库就是
 * 51 次往返。这也是 gradeQuestion 的第一个参数是 pack 而不是 db 的原因。
 */
export async function loadPack(db, subjectId) {
  const [typesRes, rubricRes, subjRes] = await db.batch([
    db.prepare('SELECT * FROM subject_question_types WHERE subject_id = ? ORDER BY sort_order, type_code')
      .bind(subjectId),
    db.prepare('SELECT version, payload FROM subject_rubrics WHERE subject_id = ? AND is_current = 1')
      .bind(subjectId),
    db.prepare('SELECT code, name FROM subjects WHERE subject_id = ?').bind(subjectId),
  ]);
  const subj = subjRes.results[0];
  if (!subj) throw fail('subject_not_found', `学科#${subjectId} 不存在`);

  const types = new Map();
  for (const r of typesRes.results) {
    let names;
    try {
      names = JSON.parse(r.normalizers || '[]');
    } catch {
      throw fail('bad_pack_json',
        `学科#${subjectId} 题型 ${r.type_code} 的 normalizers 不是合法 JSON：${String(r.normalizers).slice(0, 60)}`);
    }
    // 题型 = 作答形态 × 判分策略（§6.4.4）。两个维度都要有值：
    // 判分策略取不到就没法判分，而回落一个默认值（比如 EXACT）的后果是数值题被
    // 当成文本比对、主观题被当成客观题判 0 分，全程不报错。
    const where = `学科#${subjectId} 的题型 ${r.type_code}`;
    if (!r.grading_strategy) {
      throw fail('strategy_missing',
        `${where} 没有声明判分策略（grading_strategy）。旧库补列之后要回填，见 scripts/ci/ensure-columns.sh`);
    }
    const grader = resolveGrader(r.grading_strategy, where);
    // 题型上的 needs_ai 与策略要不要 AI 必须一致。不一致的后果是交卷时的
    // "待批改"计数与实际判分对不上：声明 needs_ai=0 的 AI 题会被当成已判分，
    // 分数记 0 而状态是"已出分"。
    if (grader.needsAi !== !!r.needs_ai) {
      throw fail('pack_inconsistent',
        `${where} 声明 needs_ai=${r.needs_ai ? 1 : 0}，但判分策略 ${r.grading_strategy} ` +
        `${grader.needsAi ? '要' : '不要'} AI`);
    }
    if (r.answer_shape && !ANSWER_SHAPES.includes(r.answer_shape)) {
      throw fail('bad_answer_shape',
        `${where} 的作答形态是 ${JSON.stringify(r.answer_shape)}，只认 ${ANSWER_SHAPES.join('、')}`);
    }
    types.set(r.type_code, {
      code: r.type_code,
      name: r.name,
      isObjective: !!r.is_objective,
      inPractice: !!r.in_practice,
      needsAi: !!r.needs_ai,
      aiReviewOnMiss: !!r.ai_review_on_miss,
      widget: r.input_widget,
      answerShape: r.answer_shape || null,
      gradingStrategy: r.grading_strategy,
      normalizers: resolveNormalizers(names, where),
      normalizerNames: names,
    });
  }
  if (!types.size) {
    throw fail('subject_pack_missing', `学科#${subjectId} 还没有声明任何题型，能力包没配`);
  }

  const rubricRow = rubricRes.results[0];
  if (!rubricRow) {
    throw fail('subject_rubric_missing', `学科#${subjectId} 没有生效中的评价标准（is_current = 1）`);
  }
  let rubric;
  try {
    rubric = JSON.parse(rubricRow.payload);
  } catch {
    throw fail('bad_pack_json', `学科#${subjectId} 的评价标准不是合法 JSON`);
  }
  for (const k of ['grading', 'essay', 'mastery']) {
    if (!rubric[k] || typeof rubric[k] !== 'object') {
      throw fail('bad_rubric', `学科#${subjectId} 的评价标准缺少 ${k} 段，顶层键为 ${Object.keys(rubric).join(',') || '（空）'}`);
    }
  }

  return {
    subjectId,
    code: subj.code,
    name: subj.name,
    rubricVersion: rubricRow.version,
    rubric,
    grading: rubric.grading,
    types,
    /** 未声明的题型要当场抛错，并把该学科声明了哪几种说出来 */
    typeOf(code) {
      const t = types.get(code);
      if (!t) {
        throw fail('question_type_not_declared',
          `学科#${subjectId} 没有声明题型 ${JSON.stringify(code)}，已声明的是 ${[...types.keys()].join('、')}`);
      }
      return t;
    },
    /** 进练习的题型（蓝本写死 question_type != 'essay'） */
    practiceTypes() {
      return [...types.values()].filter((t) => t.inPractice).map((t) => t.code);
    },
  };
}

/** 按课程取包，既有接口用得最多的入口。 */
export async function loadPackByCourse(db, courseCode) {
  return loadPack(db, await subjectIdOfCourse(db, courseCode));
}

/**
 * 取某个功能的提示词：先按学科找，找不到回落到 subject_id = 0 的全局兜底。
 * 两级都没有就抛错——一句都取不到还继续调 AI，等于拿空提示词去问，
 * 模型会返回什么谁也不知道，而那是"成功但结果不对"。
 */
export async function promptFor(db, subjectId, feature) {
  const { results } = await db.prepare(
    `SELECT subject_id, system_prompt, user_template FROM subject_ai_prompts
      WHERE feature = ? AND subject_id IN (?, 0)
      ORDER BY subject_id DESC LIMIT 1`
  ).bind(feature, subjectId).all();
  const row = results[0];
  if (!row) throw fail('prompt_missing', `学科#${subjectId} 与全局都没有 ${feature} 的提示词`);
  return { systemPrompt: row.system_prompt, userTemplate: row.user_template, fromGlobal: row.subject_id === 0 };
}

/**
 * 参数取值：学科覆盖 → 全局默认 → 抛错。
 * 不给代码兜底值：兜底值往往恰好等于种子里那个数，于是"这张表是空的"
 * 会被伪装成"配置就是这样"，一直到有人去查才发现。
 */
export async function settingInt(db, subjectId, key) {
  // prio 列不能省：UNION ALL 不保证分支顺序，光靠"学科那条写在前面"是在赌实现细节。
  // 赌输了的后果是学科覆盖被静默忽略——配置界面显示覆盖生效，实际用的还是全局值。
  const { results } = await db.prepare(
    `SELECT value, 1 AS prio FROM subject_settings WHERE subject_id = ? AND key = ?
     UNION ALL
     SELECT value, 2 AS prio FROM system_settings WHERE key = ?
     ORDER BY prio LIMIT 1`
  ).bind(subjectId, key, key).all();
  const raw = results[0]?.value;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw fail('setting_missing', `参数 ${key} 在学科#${subjectId} 与全局都取不到可用的数值（读到 ${JSON.stringify(raw)}）`);
  }
  return n;
}

/**
 * 模板渲染：只替换 {{key}}，缺的键当场抛错。
 * 留着没替换的 {{stem}} 会原样发给模型，模型照样会答，答的是另一道题。
 */
export function renderTemplate(tpl, vars) {
  const missing = [];
  const out = String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) { missing.push(k); return ''; }
    return String(vars[k] ?? '');
  });
  if (missing.length) {
    throw fail('template_vars_missing', `提示词模板里的 ${missing.join('、')} 没有取值`);
  }
  return out;
}

/**
 * 拼 question_type 的 IN 条件。
 *
 * codes 为空时返回恒假条件而不是 `IN ()`（那是语法错误）。恒假是对的语义：
 * 该学科一种题型都没声明为可练习，练习就该抽不到题——但这通常是配置漏了，
 * 所以调用方拿到空结果时该给出"该学科还没有可练习的题型"这样的提示，
 * 而不是一句"暂无题目"。
 */
export function typeInClause(codes, alias = 'q') {
  if (!codes.length) return { sql: '1 = 0', binds: [] };
  return { sql: `${alias}.question_type IN (${codes.map(() => '?').join(',')})`, binds: [...codes] };
}

/** 需要 AI 判分的题型（蓝本写死 'essay'） */
export function aiGradedTypes(pack) {
  return [...pack.types.values()].filter((t) => t.needsAi).map((t) => t.code);
}

/**
 * 一批课程各自的能力包，返回 courseCode → pack。
 *
 * 跨学科聚合的接口（后台学情、能力评估）拿到的行可能来自不同课程、不同学科，
 * 每行读一次包就是 N 次往返；这里按**学科**去重，一个学科只读一次。
 */
export async function loadPacksForCourses(db, courseCodes) {
  const codes = [...new Set(courseCodes.filter(Boolean))];
  if (!codes.length) return new Map();
  const { results } = await db.prepare(
    `SELECT course_code, subject_id FROM courses WHERE course_code IN (${codes.map(() => '?').join(',')})`
  ).bind(...codes).all();

  const bySubject = new Map();
  for (const r of results) {
    if (r.subject_id == null) {
      throw fail('course_without_subject', `课程 ${r.course_code} 还没挂到任何学科上`);
    }
    if (!bySubject.has(r.subject_id)) bySubject.set(r.subject_id, null);
  }
  for (const sid of bySubject.keys()) bySubject.set(sid, await loadPack(db, sid));

  const out = new Map();
  for (const r of results) out.set(r.course_code, bySubject.get(r.subject_id));
  return out;
}

/**
 * 校验一份 rubric 能不能用。写入路径（后台改评价标准）调用。
 * 返回问题清单，空数组表示没问题。
 *
 * 为什么不在 loadPack 里一起校验：作文维度权重写歪了只该影响作文批改，
 * 不该让整个学科的客观题也判不了分。所以写入时严查，读取时只查结构。
 */
export function validateRubricPayload(payload) {
  const problems = [];
  const p = payload || {};
  for (const k of ['grading', 'essay', 'mastery']) {
    if (!p[k] || typeof p[k] !== 'object') problems.push(`缺少 ${k} 段`);
  }
  const e = p.essay || {};
  if (e.type === 'DIMENSION_WEIGHTED') {
    const dims = Array.isArray(e.dimensions) ? e.dimensions : [];
    if (!dims.length) problems.push('DIMENSION_WEIGHTED 至少要有一个维度');
    const keys = dims.map((d) => d.key);
    if (new Set(keys).size !== keys.length) problems.push('维度的 key 有重复');
    if (dims.some((d) => !d.key)) problems.push('有维度没有 key');
    const sum = dims.reduce((a, d) => a + Number(d.weight || 0), 0);
    if (dims.length && Math.abs(sum - 1) > 0.001) {
      // 合计 1.2 的话分数整体虚高 20%，而批改照常"成功"
      problems.push(`维度权重合计是 ${sum.toFixed(3)}，应当为 1`);
    }
    if (!(Number(e.dimensionMax) > 0)) problems.push('dimensionMax 要是正数');
    if (!(Number(e.totalScore) > 0)) problems.push('totalScore 要是正数');
  } else if (e.type === 'LEVEL_BANDED') {
    // 分档评分（§6.6②类型 C）：AI 先选档、再在档内给分。档次区间写歪了，
    // 判分会当场抛 ai_bad_shape——那时学生正在等分数，所以在写入时就拦住。
    const bands = Array.isArray(e.bands) ? e.bands : [];
    const full = Number(e.totalScore);
    if (!bands.length) problems.push('LEVEL_BANDED 至少要有一个档次');
    if (!(full > 0)) problems.push('totalScore 要是正数');
    const levels = bands.map((b) => String(b.level));
    if (new Set(levels).size !== levels.length) problems.push('档次的 level 有重复');
    let covered = [];
    for (const b of bands) {
      const r = Array.isArray(b.range) ? b.range : [];
      const lo = Number(r[0]);
      const hi = Number(r[1]);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) {
        problems.push(`档次 ${b.level} 的 range 不是 [下限, 上限]：${JSON.stringify(b.range)}`);
        continue;
      }
      if (full > 0 && (lo < 0 || hi > full)) {
        problems.push(`档次 ${b.level} 的 ${lo}～${hi} 超出了满分 ${full}`);
      }
      // 区间重叠时同一个分数对应两个档，落档理由就没法核对了
      for (const [plo, phi, plevel] of covered) {
        if (lo <= phi && plo <= hi) problems.push(`档次 ${b.level} 与 ${plevel} 的分数区间重叠`);
      }
      covered.push([lo, hi, b.level]);
      if (!String(b.desc || '').trim()) problems.push(`档次 ${b.level} 没写档次描述，AI 没有落档依据`);
    }
  } else if (e.type !== 'POINT_HIT') {
    problems.push(`认不出的 essay.type：${JSON.stringify(e.type)}（目前支持 DIMENSION_WEIGHTED、POINT_HIT、LEVEL_BANDED）`);
  }
  // 开放采分点的权重占比上限（§6.4.5 G8）。超过它，采分点式判分就退化成
  // AI 凭印象打分，失去了"可核对"这个唯一的好处。
  if (e.openWeightCap !== undefined) {
    const cap = Number(e.openWeightCap);
    if (!(cap > 0) || cap > 1) problems.push(`openWeightCap 是 ${JSON.stringify(e.openWeightCap)}，要在 0～1 之间`);
  }

  const m = p.mastery || {};
  for (const k of ['masteredMinTotal', 'masteredMinStreak', 'weakRateBelow']) {
    if (!Number.isFinite(Number(m[k]))) problems.push(`mastery.${k} 不是数字`);
  }
  // 得分率到多少算"答对"（§6.6③）。部分分题型全靠它分档：写成 0.6 的话，
  // 10 空答对 6 空就算掌握了这个考点，以后不再抽它——这是个要有人明确拍板的数，
  // 不能靠代码里的默认值悄悄定下来。
  const th = Number(m.correctThreshold);
  if (!(th > 0) || th > 1) {
    problems.push(`mastery.correctThreshold 是 ${JSON.stringify(m.correctThreshold)}，要在 0～1 之间（1 表示必须全对）`);
  }
  const w = m.weights || {};
  for (const k of ['untested', 'lastWrong']) {
    if (!Number.isFinite(Number(w[k]))) problems.push(`mastery.weights.${k} 不是数字`);
  }
  const ladder = Array.isArray(w.byStreak) ? w.byStreak : null;
  if (!ladder || !ladder.length) problems.push('mastery.weights.byStreak 要是非空数组');
  else if (ladder[ladder.length - 1].upTo !== null) {
    // 没有兜底档的话，连对次数超出梯子时 tagWeight 会抛错，
    // 表现为练习抽不出题——而配置界面当时什么都没说
    problems.push('mastery.weights.byStreak 的最后一档要写成 upTo: null 作兜底');
  }
  if (!(Number(p.fullScore) > 0)) problems.push('fullScore 要是正数');
  return problems;
}
