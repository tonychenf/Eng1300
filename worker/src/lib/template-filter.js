// 组卷模板的结构化筛选器（需求文档 §6.4.8）。
//
// 蓝本的 exam_templates 只能按题型组卷：(course_code, ord, section_type, ...)。
// 生化的主路径是按章节练习，模考也要按章节配比，按考点、按难度同样表达不了。
// 改成一段 JSON：{ questionTypes?, sectionTypes?, knowledgePoints?, difficulty? }，多条件取交集。
//
// **认不出的筛选条件一律抛错**，不忽略。忽略的后果是卷子照样组得出来，只是题选错了——
// 管理员把 filter 写成 {chapters:[1,2]}（少个 No），拿到的是全库随机抽题，而界面上
// 一切正常。
const KNOWN = ['questionTypes', 'sectionTypes', 'knowledgePoints', 'difficulty'];
const PLANNED = {
  chapterNos: '按章节筛选要先有内容组（§6.4.2），N6 随生化内容一起做',
  contentGroups: '按内容组筛选要先有内容组（§6.4.2），N6 随生化内容一起做',
};

function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

export function parseFilter(raw, where) {
  let f;
  if (raw === undefined || raw === null || raw === '') f = {};
  else if (typeof raw === 'object') f = raw;
  else {
    try { f = JSON.parse(raw); } catch {
      throw fail('bad_filter', `${where} 的 filter 不是合法 JSON：${String(raw).slice(0, 60)}`);
    }
  }
  if (!f || typeof f !== 'object' || Array.isArray(f)) {
    throw fail('bad_filter', `${where} 的 filter 要是对象，收到 ${Array.isArray(f) ? '数组' : typeof f}`);
  }
  for (const k of Object.keys(f)) {
    if (KNOWN.includes(k)) continue;
    if (PLANNED[k]) throw fail('unsupported_filter', `${where} 用了筛选条件 ${k}：${PLANNED[k]}`);
    throw fail('unsupported_filter',
      `${where} 用了认不出的筛选条件 ${JSON.stringify(k)}，认得的是 ${KNOWN.join('、')}`);
  }
  for (const k of KNOWN) {
    if (f[k] !== undefined && (!Array.isArray(f[k]) || !f[k].length)) {
      throw fail('bad_filter', `${where} 的 ${k} 要是非空数组，收到 ${JSON.stringify(f[k])}`);
    }
  }
  return f;
}

/**
 * 把筛选器翻成作用在 questions q 上的 SQL 条件。
 * 返回 { sql, binds }；没有任何条件时 sql 是 '1 = 1'。
 * knowledgePoints 用 EXISTS 子查询，因为一道题挂多个考点，join 会把行数放大。
 */
export function filterToSql(filter, alias = 'q') {
  const parts = [];
  const binds = [];
  const inList = (col, values) => {
    parts.push(`${alias}.${col} IN (${values.map(() => '?').join(',')})`);
    binds.push(...values);
  };
  if (filter.questionTypes) inList('question_type', filter.questionTypes);
  if (filter.sectionTypes) inList('section_type', filter.sectionTypes);
  if (filter.difficulty) inList('difficulty_tag', filter.difficulty);
  if (filter.knowledgePoints) {
    parts.push(
      `EXISTS (SELECT 1 FROM question_knowledge_points x
                WHERE x.question_id = ${alias}.question_id
                  AND x.tag_id IN (${filter.knowledgePoints.map(() => '?').join(',')}))`
    );
    binds.push(...filter.knowledgePoints);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', binds };
}

/** 模板项一行 → 计划要用的形状，顺带把该拒的配置在组卷之前就拒掉。 */
export function toTemplateItem(row) {
  const where = `课程 ${row.course_code} 的模板第 ${row.ord} 项「${row.label}」`;
  const count = Number(row.question_count);
  if (!Number.isInteger(count) || count <= 0) {
    throw fail('bad_template', `${where} 的题量是 ${JSON.stringify(row.question_count)}，要求正整数`);
  }
  if (row.score_mode === 'FROM_QUESTION') {
    // §6.4.7 定的是"题目给相对权重、模板给绝对分"，所以题目上根本没有绝对分值这一列。
    // 这个口子要等真有学科需要"卷面总分浮动"时再开，那时先加列再实现，
    // 而不是现在悄悄拿模板分顶上——顶上了就等于这个配置项没起作用。
    throw fail('score_mode_not_implemented',
      `${where} 用了 FROM_QUESTION：题目自带绝对分值的口子还没开（题目表上没有分值列），` +
      '改回 FROM_TEMPLATE，或者先按 §6.4.7 的例外口子加列');
  }
  const score = Number(row.score_per_question);
  if (!Number.isFinite(score) || score <= 0) {
    throw fail('bad_template', `${where} 的每题分值是 ${JSON.stringify(row.score_per_question)}，要求正数`);
  }
  if (row.pick_unit !== 'SECTION' && row.pick_unit !== 'QUESTION') {
    throw fail('bad_template', `${where} 的抽题单位是 ${JSON.stringify(row.pick_unit)}，只认 SECTION / QUESTION`);
  }
  return {
    ord: Number(row.ord),
    label: String(row.label),
    filter: parseFilter(row.filter, where),
    questionCount: count,
    scorePerQuestion: score,
    pickUnit: row.pick_unit,
    where,
  };
}
