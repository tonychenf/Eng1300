// 组卷：按 docs/prd.md §7.1 的考点多样化算法从题库抽题。
//
// N5 改造（§6.4.8）：选题条件从"题型 + 题量"泛化成 exam_template_items 的结构化
// 筛选器，抽题单位下放到模板项。英语的七个模板项是从 exam_templates 原样生成的
// （filter 只填 sectionTypes、pick_unit=SECTION），所以行为与改造前完全一致。
//
// 抽题单位有两种：
//   SECTION  整篇抽。阅读类拆开就没有语境了；一篇只有在它的已发布题量正好等于模板
//            要求时才算候选，少一题就凑不满，被扣下的存疑题会带着整篇一起落选。
//   QUESTION 单题抽。生化的填空、选择没有篇章语境，整篇抽反而抽不出题。
import { toTemplateItem, filterToSql } from './template-filter.js';
import { pickableSql } from './pickable.js';

const RECENT_DEFAULT = 3;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

async function loadTemplate(db, courseCode) {
  const { results } = await db.prepare(
    `SELECT course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit
       FROM exam_template_items WHERE course_code = ? ORDER BY ord`
  ).bind(courseCode).all();
  if (!results.length) {
    throw fail('insufficient_questions', '该课程没有配置组卷模板');
  }
  return results.map(toTemplateItem);
}

// 候选篇章：该课程、符合筛选条件、已发布题量正好等于模板要求
async function candidateSections(db, courseCode, item) {
  const f = filterToSql(item.filter);
  const { results } = await db.prepare(
    `SELECT s.section_id, s.exam_id, s.passage_title,
            COUNT(q.question_id) AS published_count
       FROM sections s
       JOIN exams e ON e.exam_id = s.exam_id
       JOIN questions q ON q.section_id = s.section_id AND ${pickableSql('q')} AND (${f.sql})
      WHERE e.course_code = ? AND e.status = '已发布'
      GROUP BY s.section_id
     HAVING published_count = ?`
  ).bind(...f.binds, courseCode, item.questionCount).all();
  return results;
}

// 候选单题：该课程、符合筛选条件、已发布。
//
// **带篇章原文的题不单题抽**：它的题干离开原文就读不懂了（§6.4.9 的 requires_context
// 说的就是这件事）。那个声明字段要等题目契约落地（N6）才有，在那之前用"所属篇章有没有
// 原文"来判断——这不是猜，现有 schema 里这就是"这道题依赖材料"的表达方式。
async function candidateQuestions(db, courseCode, item) {
  const f = filterToSql(item.filter);
  const { results } = await db.prepare(
    `SELECT q.question_id, q.section_id
       FROM questions q
       JOIN sections s ON s.section_id = q.section_id
       JOIN exams e ON e.exam_id = q.exam_id
      WHERE q.course_code = ? AND ${pickableSql('q')} AND e.status = '已发布'
        AND (s.passage_text IS NULL OR s.passage_text = '')
        AND (${f.sql})
      ORDER BY q.question_id`
  ).bind(courseCode, ...f.binds).all();
  return results;
}

// 最近 N 次模考用过的篇章，避免连着抽到同一篇原文
async function recentSectionIds(db, userId, courseCode, recentN) {
  const { results } = await db.prepare(
    `SELECT DISTINCT aq.section_id
       FROM attempt_questions aq
       JOIN attempts a ON a.attempt_id = aq.attempt_id
      WHERE a.user_id = ? AND a.course_code = ? AND a.mode = 'EXAM'
        AND a.attempt_id IN (
          SELECT attempt_id FROM attempts
           WHERE user_id = ? AND course_code = ? AND mode = 'EXAM'
           ORDER BY started_at DESC LIMIT ?
        )`
  ).bind(userId, courseCode, userId, courseCode, recentN).all();
  return new Set(results.map((r) => r.section_id));
}

// 最近 N 次模考做过的题，单题抽时避开
async function recentQuestionIds(db, userId, courseCode, recentN) {
  const { results } = await db.prepare(
    `SELECT DISTINCT aq.question_id
       FROM attempt_questions aq
       JOIN attempts a ON a.attempt_id = aq.attempt_id
      WHERE a.user_id = ? AND a.course_code = ? AND a.mode = 'EXAM'
        AND a.attempt_id IN (
          SELECT attempt_id FROM attempts
           WHERE user_id = ? AND course_code = ? AND mode = 'EXAM'
           ORDER BY started_at DESC LIMIT ?
        )`
  ).bind(userId, courseCode, userId, courseCode, recentN).all();
  return new Set(results.map((r) => r.question_id));
}

// 每篇覆盖的考点
async function sectionTags(db, sectionIds) {
  if (!sectionIds.length) return new Map();
  const holes = sectionIds.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT q.section_id, x.tag_id
       FROM questions q
       JOIN question_knowledge_points x ON x.question_id = q.question_id
      WHERE q.section_id IN (${holes}) AND ${pickableSql('q')}`
  ).bind(...sectionIds).all();
  const map = new Map(sectionIds.map((id) => [id, new Set()]));
  for (const r of results) map.get(r.section_id)?.add(r.tag_id);
  return map;
}

// 每道题挂的考点
async function questionTags(db, questionIds) {
  const map = new Map(questionIds.map((id) => [id, new Set()]));
  for (let i = 0; i < questionIds.length; i += 90) {
    const batch = questionIds.slice(i, i + 90);
    const { results } = await db.prepare(
      `SELECT question_id, tag_id FROM question_knowledge_points
        WHERE question_id IN (${batch.map(() => '?').join(',')})`
    ).bind(...batch).all();
    for (const r of results) map.get(r.question_id)?.add(r.tag_id);
  }
  return map;
}

// 用户在各考点上的正确率，用于难度倾向加权
async function tagAccuracy(db, userId, courseCode) {
  const { results } = await db.prepare(
    `SELECT tag_id, correct_count, wrong_count
       FROM user_knowledge_mastery WHERE user_id = ? AND course_code = ?`
  ).bind(userId, courseCode).all();
  const map = new Map();
  for (const r of results) {
    const total = r.correct_count + r.wrong_count;
    if (total > 0) map.set(r.tag_id, r.correct_count / total);
  }
  return map;
}

// 一篇（或一题）的难度权重：简单=挑做得好的，困难=挑做得差的，正常=挑中间的。
// 没做过的考点一律按 0.5 处理，既不特别偏好也不排斥。
function difficultyWeight(difficulty, tags, accuracy) {
  if (difficulty === '随机' || !tags.size) return 1;
  let sum = 0;
  for (const t of tags) sum += accuracy.has(t) ? accuracy.get(t) : 0.5;
  const acc = sum / tags.size;
  if (difficulty === '简单') return acc + 0.05;
  if (difficulty === '困难') return (1 - acc) + 0.05;
  return 1 - Math.abs(acc - 0.5) + 0.05; // 正常
}

function pickWeighted(items, weightOf) {
  const total = items.reduce((n, it) => n + weightOf(it), 0);
  let r = Math.random() * total;
  for (const it of items) {
    r -= weightOf(it);
    if (r <= 0) return it;
  }
  return items[items.length - 1];
}

// 与已用考点重叠最少的那些，并列时按难度权重随机挑一个
function pickDiverse(pool, tagOf, usedTags, difficulty, accuracy) {
  let best = Infinity;
  let tied = [];
  for (const cand of pool) {
    const tags = tagOf(cand);
    let overlap = 0;
    for (const t of tags) if (usedTags.has(t)) overlap++;
    if (overlap < best) { best = overlap; tied = [cand]; }
    else if (overlap === best) tied.push(cand);
  }
  const picked = pickWeighted(tied, (cand) => difficultyWeight(difficulty, tagOf(cand), accuracy));
  return { picked, overlap: best };
}

/**
 * 生成一套卷子。
 *
 * 返回 { parts: [{ ord, label, pickUnit, scorePerQuestion,
 *                  questions: [{questionId, sectionId}] }], warnings, knowledgePointCount }
 *
 * **哪些题上卷由这里定死**，不是让调用方再查一遍：卷面总分要从"实际写进
 * attempt_questions 的那些行"算出来（§6.4.7），两处各查一次就有可能对不上。
 * 题库不足以凑齐某个部分时抛出 code='insufficient_questions' 的错误。
 */
export async function planPaper(db, { courseCode, userId, difficulty = '随机', recentAvoid = RECENT_DEFAULT }) {
  const template = await loadTemplate(db, courseCode);
  const recentSections = await recentSectionIds(db, userId, courseCode, recentAvoid);
  const recentQuestions = await recentQuestionIds(db, userId, courseCode, recentAvoid);
  const accuracy = await tagAccuracy(db, userId, courseCode);

  const parts = [];
  const warnings = [];
  const usedTags = new Set();

  for (const item of template) {
    const part = {
      ord: item.ord, label: item.label, pickUnit: item.pickUnit,
      scorePerQuestion: item.scorePerQuestion, questions: [],
    };

    if (item.pickUnit === 'SECTION') {
      const all = await candidateSections(db, courseCode, item);
      if (!all.length) {
        throw fail('insufficient_questions',
          `题库里没有满足「${item.label}」${item.questionCount} 题要求的完整篇章`);
      }
      // 优先排除最近做过的；全被排除了就退回全集，宁可重复也要出得成卷
      let pool = all.filter((s) => !recentSections.has(s.section_id));
      if (!pool.length) {
        pool = all;
        warnings.push(`「${item.label}」可选篇章都在最近 ${recentAvoid} 次考过，本次可能重复`);
      }
      const tagMap = await sectionTags(db, pool.map((s) => s.section_id));
      const { picked, overlap } = pickDiverse(
        pool, (s) => tagMap.get(s.section_id) || new Set(), usedTags, difficulty, accuracy);
      if (overlap > 0) {
        warnings.push(`「${item.label}」有 ${overlap} 个考点与本卷其它部分重复，该题型的题库考点数偏少`);
      }
      for (const t of tagMap.get(picked.section_id) || []) usedTags.add(t);

      const { results: qs } = await db.prepare(
        `SELECT question_id FROM questions
          WHERE section_id = ? AND ${pickableSql('')} ORDER BY ord`
      ).bind(picked.section_id).all();
      part.questions = qs.map((q) => ({ questionId: q.question_id, sectionId: picked.section_id }));
    } else {
      const all = await candidateQuestions(db, courseCode, item);
      if (all.length < item.questionCount) {
        throw fail('insufficient_questions',
          `题库里符合「${item.label}」条件的已发布题只有 ${all.length} 道，模板要 ${item.questionCount} 道`);
      }
      let pool = all.filter((q) => !recentQuestions.has(q.question_id));
      if (pool.length < item.questionCount) {
        pool = all;
        warnings.push(`「${item.label}」可选题不够避开最近 ${recentAvoid} 次做过的，本次可能重复`);
      }
      const tagMap = await questionTags(db, pool.map((q) => q.question_id));
      // 逐题挑：每次都挑与"本卷已用考点"重叠最少的，挑完把它的考点计入。
      // 这样同一份卷子里考点尽量铺开，与整篇抽那条路的贪心是同一个口径。
      const left = new Map(pool.map((q) => [q.question_id, q]));
      for (let i = 0; i < item.questionCount; i++) {
        const { picked } = pickDiverse(
          [...left.values()], (q) => tagMap.get(q.question_id) || new Set(), usedTags, difficulty, accuracy);
        left.delete(picked.question_id);
        for (const t of tagMap.get(picked.question_id) || []) usedTags.add(t);
        part.questions.push({ questionId: picked.question_id, sectionId: picked.section_id });
      }
    }

    if (!part.questions.length) {
      throw fail('insufficient_questions', `「${item.label}」一道题都没抽到`);
    }
    parts.push(part);
  }

  return { parts, warnings, knowledgePointCount: usedTags.size };
}
