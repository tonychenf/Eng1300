// 组卷：按 docs/prd.md §7.1 的考点多样化算法从题库抽题。
//
// 抽题的单位是"篇章"（section），不是单题——阅读类拆开就没有语境了。
// 一篇只有在它的已发布题量正好等于模板要求时才算候选：少一题就凑不满，
// 被扣下的存疑题会自动带着整篇一起落选。

const RECENT_DEFAULT = 3;

// 候选篇章：该课程、该题型、已发布题量正好等于模板要求
async function candidateSections(db, courseCode, sectionType, questionCount) {
  const { results } = await db.prepare(
    `SELECT s.section_id, s.exam_id, s.passage_title,
            COUNT(q.question_id) AS published_count
       FROM sections s
       JOIN exams e ON e.exam_id = s.exam_id
       JOIN questions q ON q.section_id = s.section_id AND q.status = '已发布'
      WHERE e.course_code = ? AND e.status = '已发布' AND s.type = ?
      GROUP BY s.section_id
     HAVING published_count = ?`
  ).bind(courseCode, sectionType, questionCount).all();
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

// 每篇覆盖的考点
async function sectionTags(db, sectionIds) {
  if (!sectionIds.length) return new Map();
  const holes = sectionIds.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT q.section_id, x.tag_id
       FROM questions q
       JOIN question_knowledge_points x ON x.question_id = q.question_id
      WHERE q.section_id IN (${holes}) AND q.status = '已发布'`
  ).bind(...sectionIds).all();
  const map = new Map(sectionIds.map((id) => [id, new Set()]));
  for (const r of results) map.get(r.section_id)?.add(r.tag_id);
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

// 一篇的难度权重：简单=挑做得好的，困难=挑做得差的，正常=挑中间的。
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

/**
 * 生成一套卷子的篇章组合。
 * 返回 { sections: [{sectionOrd, sectionType, sectionId, scorePerQuestion}], warnings: [] }
 * 题库不足以凑齐某个部分时抛出 code='insufficient_questions' 的错误。
 */
export async function planPaper(db, { courseCode, userId, difficulty = '随机', recentAvoid = RECENT_DEFAULT }) {
  const { results: template } = await db.prepare(
    `SELECT ord, section_type, question_count, score_per_question
       FROM exam_templates WHERE course_code = ? ORDER BY ord`
  ).bind(courseCode).all();
  if (!template.length) {
    const e = new Error('该课程没有配置组卷模板');
    e.code = 'insufficient_questions';
    throw e;
  }

  const recent = await recentSectionIds(db, userId, courseCode, recentAvoid);
  const accuracy = await tagAccuracy(db, userId, courseCode);

  const chosen = [];
  const warnings = [];
  const usedTags = new Set();

  for (const row of template) {
    const all = await candidateSections(db, courseCode, row.section_type, row.question_count);
    if (!all.length) {
      const e = new Error(`题库里没有满足「${row.section_type}」${row.question_count} 题要求的完整篇章`);
      e.code = 'insufficient_questions';
      throw e;
    }

    // 优先排除最近做过的；全被排除了就退回全集，宁可重复也要出得成卷
    let pool = all.filter((s) => !recent.has(s.section_id));
    if (!pool.length) {
      pool = all;
      warnings.push(`「${row.section_type}」可选篇章都在最近 ${recentAvoid} 次考过，本次可能重复`);
    }

    const tagMap = await sectionTags(db, pool.map((s) => s.section_id));

    // 贪心：与本卷已选考点重叠最少的一篇；并列时按难度权重随机
    let best = Infinity;
    let tied = [];
    for (const s of pool) {
      const tags = tagMap.get(s.section_id) || new Set();
      let overlap = 0;
      for (const t of tags) if (usedTags.has(t)) overlap++;
      if (overlap < best) { best = overlap; tied = [s]; }
      else if (overlap === best) tied.push(s);
    }

    const picked = pickWeighted(tied, (s) =>
      difficultyWeight(difficulty, tagMap.get(s.section_id) || new Set(), accuracy)
    );
    if (best > 0) {
      warnings.push(`「${row.section_type}」有 ${best} 个考点与本卷其它部分重复，该题型的题库考点数偏少`);
    }

    for (const t of tagMap.get(picked.section_id) || []) usedTags.add(t);
    chosen.push({
      sectionOrd: row.ord,
      sectionType: row.section_type,
      sectionId: picked.section_id,
      questionCount: row.question_count,
      scorePerQuestion: row.score_per_question,
    });
  }

  return { sections: chosen, warnings, knowledgePointCount: usedTags.size };
}
