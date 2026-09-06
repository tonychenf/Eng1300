// 考点掌握度：连续答对次数与最近结果。
// 模考交卷和练习答题都走这里，保证两边口径一致。
//
// M3 那版只累计了对错次数，consecutive_correct 一直留 0——当时还没人用它。
// M4 的强化阶段要按它定抽题权重，所以这里补齐。

/** PRD §7.3 掌握度档位 */
export function masteryTier(row) {
  const total = (row.correct_count || 0) + (row.wrong_count || 0);
  if (total === 0) return '未测';
  if (row.last_result === 'wrong') return '薄弱';
  if (total >= 3 && (row.consecutive_correct || 0) >= 3) return '已掌握';
  const recentRate = total ? (row.correct_count || 0) / total : 0;
  if (recentRate < 0.5) return '薄弱';
  if (total >= 2) return '待巩固';
  return '待巩固';
}

/** PRD §7.2 强化阶段的抽取权重。答对也永不归零，用来复验"蒙对"的考点。 */
export function tagWeight(row) {
  if (!row) return 2.0;                       // 从未测过
  const total = (row.correct_count || 0) + (row.wrong_count || 0);
  if (total === 0) return 2.0;
  if (row.last_result === 'wrong') return 5.0; // 最近一次答错
  const streak = row.consecutive_correct || 0;
  if (streak <= 1) return 2.0;
  if (streak === 2) return 1.0;
  return 0.3;                                  // 连对三次及以上，保底不为零
}

/**
 * 按作答顺序推进掌握度，返回待写入的语句。
 * entries: [{ tagIds: string[], isCorrect: 0|1 }]，顺序即作答顺序。
 */
export async function masteryWrites(db, userId, courseCode, entries) {
  const tagIds = [...new Set(entries.flatMap((e) => e.tagIds))];
  if (!tagIds.length) return [];

  const holes = tagIds.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT * FROM user_knowledge_mastery
      WHERE user_id = ? AND course_code = ? AND tag_id IN (${holes})`
  ).bind(userId, courseCode, ...tagIds).all();

  const state = new Map();
  for (const r of results) state.set(r.tag_id, { ...r });
  for (const id of tagIds) {
    if (!state.has(id)) {
      state.set(id, {
        tag_id: id, correct_count: 0, wrong_count: 0,
        consecutive_correct: 0, last_result: null,
      });
    }
  }

  // 按作答先后逐条推进，同一考点在一份卷子里出现多次时连对次数才算得对
  for (const e of entries) {
    for (const id of e.tagIds) {
      const s = state.get(id);
      if (e.isCorrect === 1) {
        s.correct_count++;
        s.consecutive_correct++;
        s.last_result = 'correct';
      } else {
        s.wrong_count++;
        s.consecutive_correct = 0;
        s.last_result = 'wrong';
      }
    }
  }

  return [...state.values()].map((s) =>
    db.prepare(
      `INSERT INTO user_knowledge_mastery
         (user_id, course_code, tag_id, correct_count, wrong_count,
          consecutive_correct, last_result, last_practiced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(user_id, course_code, tag_id) DO UPDATE SET
         correct_count = excluded.correct_count,
         wrong_count = excluded.wrong_count,
         consecutive_correct = excluded.consecutive_correct,
         last_result = excluded.last_result,
         last_practiced_at = excluded.last_practiced_at`
    ).bind(userId, courseCode, s.tag_id, s.correct_count, s.wrong_count,
           s.consecutive_correct, s.last_result)
  );
}

/** 取某题的考点标签 */
export async function tagsOfQuestion(db, questionId) {
  const { results } = await db.prepare(
    'SELECT tag_id FROM question_knowledge_points WHERE question_id = ?'
  ).bind(questionId).all();
  return results.map((r) => r.tag_id);
}
