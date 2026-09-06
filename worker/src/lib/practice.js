// 专项练习的出题算法。对应 docs/prd.md §7.2。
//
// 三个阶段：
//   摸底   —— 每个考点先出一道，尽快把缺陷面铺开
//   强化   —— 按掌握度加权抽考点，答错的权重最高，答对的降权但永不归零，
//             所以"蒙对"的考点还会被复验
//   单考点 —— 把某个考点下的题全部做一遍
import { tagWeight } from './mastery.js';

// 强化阶段避免重复的窗口：最近这么多道题里出现过的题不再出
const RECENT_WINDOW_DEFAULT = 20;

function inClause(values) {
  return values.map(() => '?').join(',');
}

/** 本次范围内可用的考点及其题量。范围 = 课程 + 题型集合 (+ 可选的考点子集) */
export async function scopeTags(db, { courseCode, sectionTypes, knowledgePoints }) {
  const conds = ["q.course_code = ?", "q.status = '已发布'"];
  const binds = [courseCode];
  if (sectionTypes?.length) {
    conds.push(`q.section_type IN (${inClause(sectionTypes)})`);
    binds.push(...sectionTypes);
  }
  if (knowledgePoints?.length) {
    conds.push(`x.tag_id IN (${inClause(knowledgePoints)})`);
    binds.push(...knowledgePoints);
  }
  const { results } = await db.prepare(
    `SELECT x.tag_id, k.name, COUNT(DISTINCT q.question_id) AS question_count
       FROM questions q
       JOIN question_knowledge_points x ON x.question_id = q.question_id
       JOIN knowledge_points k ON k.tag_id = x.tag_id
      WHERE ${conds.join(' AND ')}
      GROUP BY x.tag_id, k.name
      ORDER BY question_count DESC, k.name`
  ).bind(...binds).all();
  return results;
}

/** 本次范围内可用的题目总数（去重） */
export async function scopeQuestionCount(db, scope) {
  const tags = await scopeTags(db, scope);
  if (!tags.length) return 0;
  const conds = ["q.course_code = ?", "q.status = '已发布'"];
  const binds = [scope.courseCode];
  if (scope.sectionTypes?.length) {
    conds.push(`q.section_type IN (${inClause(scope.sectionTypes)})`);
    binds.push(...scope.sectionTypes);
  }
  if (scope.knowledgePoints?.length) {
    conds.push(`x.tag_id IN (${inClause(scope.knowledgePoints)})`);
    binds.push(...scope.knowledgePoints);
  }
  const row = await db.prepare(
    `SELECT COUNT(DISTINCT q.question_id) AS n
       FROM questions q
       JOIN question_knowledge_points x ON x.question_id = q.question_id
      WHERE ${conds.join(' AND ')}`
  ).bind(...binds).first();
  return row?.n || 0;
}

/** 该用户在这些考点上的掌握度 */
async function masteryOf(db, userId, courseCode, tagIds) {
  if (!tagIds.length) return new Map();
  const { results } = await db.prepare(
    `SELECT * FROM user_knowledge_mastery
      WHERE user_id = ? AND course_code = ? AND tag_id IN (${inClause(tagIds)})`
  ).bind(userId, courseCode, ...tagIds).all();
  return new Map(results.map((r) => [r.tag_id, r]));
}

/** 本次练习已经覆盖过的考点 */
async function coveredTags(db, attemptId) {
  const { results } = await db.prepare(
    `SELECT DISTINCT x.tag_id
       FROM attempt_questions aq
       JOIN question_knowledge_points x ON x.question_id = aq.question_id
      WHERE aq.attempt_id = ?`
  ).bind(attemptId).all();
  return new Set(results.map((r) => r.tag_id));
}

/** 本次练习已经出过的题 */
async function askedQuestions(db, attemptId) {
  const { results } = await db.prepare(
    'SELECT question_id, ord FROM attempt_questions WHERE attempt_id = ? ORDER BY ord'
  ).bind(attemptId).all();
  return results;
}

/**
 * 从某个考点下挑一道题。
 * 先排除本次已出过的，再排除最近窗口内做过的；都排完了就退回"历史做得最少的"。
 */
async function pickForTag(db, { userId, tagId, scope, excludeIds, recentIds }) {
  const conds = ["q.course_code = ?", "q.status = '已发布'", 'x.tag_id = ?'];
  const binds = [scope.courseCode, tagId];
  if (scope.sectionTypes?.length) {
    conds.push(`q.section_type IN (${inClause(scope.sectionTypes)})`);
    binds.push(...scope.sectionTypes);
  }

  // 历史作答次数：跨该用户全部作答统计，用来优先出没做过的题
  const { results } = await db.prepare(
    `SELECT q.question_id,
            (SELECT COUNT(*) FROM answer_records r
               JOIN attempts a ON a.attempt_id = r.attempt_id
              WHERE r.question_id = q.question_id AND a.user_id = ?) AS done_count
       FROM questions q
       JOIN question_knowledge_points x ON x.question_id = q.question_id
      WHERE ${conds.join(' AND ')}
      ORDER BY done_count, q.question_id`
  ).bind(userId, ...binds).all();

  if (!results.length) return null;
  const usable = results.filter((r) => !excludeIds.has(r.question_id));
  if (!usable.length) return null;

  const fresh = usable.filter((r) => !recentIds.has(r.question_id));
  const pool = fresh.length ? fresh : usable;

  // 并列的（做过次数相同）随机取一个，避免每次都固定同一道
  const best = pool[0].done_count;
  const tied = pool.filter((r) => r.done_count === best);
  return tied[Math.floor(Math.random() * tied.length)].question_id;
}

function pickWeightedTag(tags, mastery) {
  const weights = tags.map((t) => tagWeight(mastery.get(t.tag_id)));
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < tags.length; i++) {
    r -= weights[i];
    if (r <= 0) return tags[i];
  }
  return tags[tags.length - 1];
}

/**
 * 决定下一题。
 * 返回 { questionId, stage, tagId } 或 { done: true, reason } —— 范围内的题出完了。
 */
export async function nextQuestion(db, attempt, { batchSize, recentWindow = RECENT_WINDOW_DEFAULT }) {
  const scope = {
    courseCode: attempt.course_code,
    sectionTypes: attempt.scope_section_types ? JSON.parse(attempt.scope_section_types) : null,
    knowledgePoints: attempt.scope_knowledge_point ? [attempt.scope_knowledge_point] : null,
  };

  const asked = await askedQuestions(db, attempt.attempt_id);
  const excludeIds = new Set(asked.map((a) => a.question_id));
  const recentIds = new Set(asked.slice(-recentWindow).map((a) => a.question_id));

  const tags = await scopeTags(db, scope);
  if (!tags.length) return { done: true, reason: 'empty_scope' };

  // 单考点专项：把这个考点的题做完为止
  if (attempt.practice_stage === '单考点专项') {
    const qid = await pickForTag(db, { userId: attempt.user_id, tagId: tags[0].tag_id, scope, excludeIds, recentIds: new Set() });
    return qid ? { questionId: qid, stage: '单考点专项', tagId: tags[0].tag_id } : { done: true, reason: 'exhausted' };
  }

  const mastery = await masteryOf(db, attempt.user_id, attempt.course_code, tags.map((t) => t.tag_id));

  // 摸底：每个考点先出一道。考点多于一批时，没测过的、题量多的优先。
  if (attempt.practice_stage === '摸底') {
    const covered = await coveredTags(db, attempt.attempt_id);
    const ordered = [...tags].sort((a, b) => {
      const au = mastery.has(a.tag_id) ? 1 : 0;
      const bu = mastery.has(b.tag_id) ? 1 : 0;
      if (au !== bu) return au - bu;                     // 没测过的排前面
      return b.question_count - a.question_count;        // 再按题量多的优先
    }).slice(0, batchSize);

    for (const t of ordered) {
      if (covered.has(t.tag_id)) continue;
      const qid = await pickForTag(db, { userId: attempt.user_id, tagId: t.tag_id, scope, excludeIds, recentIds: new Set() });
      if (qid) return { questionId: qid, stage: '摸底', tagId: t.tag_id };
    }
    // 这一批考点都出过了，转入强化
  }

  // 强化：按权重抽考点，抽不出题就换一个，全都抽不出说明范围内的题做完了
  const candidates = [...tags];
  while (candidates.length) {
    const t = pickWeightedTag(candidates, mastery);
    const qid = await pickForTag(db, { userId: attempt.user_id, tagId: t.tag_id, scope, excludeIds, recentIds });
    if (qid) return { questionId: qid, stage: '强化', tagId: t.tag_id };
    candidates.splice(candidates.indexOf(t), 1);
  }
  return { done: true, reason: 'exhausted' };
}
