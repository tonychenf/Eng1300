// 错题本的记账逻辑（PRD §5.7）。
//
// 关键点：错题在判分时就落库，不等 AI。AI 之后只往 error_analysis 和
// memory_point 两个字段里补内容。这样 AI 不可用时错题本照样能用。
//
// 订正规则：同一题再次做错则累计次数并把连对清零；后续连续答对 2 次
// 自动标记为已订正。已订正的题再错会重新变回未订正。

const CORRECT_STREAK_TO_CLEAR = 2;

/**
 * @param entries [{ questionId, isCorrect }]，只传客观题（作文没有对错）
 * @returns 待执行的语句数组
 */
export async function wrongbookWrites(db, userId, courseCode, entries, { attemptId, source }) {
  const wrong = entries.filter((e) => e.isCorrect === 0).map((e) => e.questionId);
  const right = entries.filter((e) => e.isCorrect === 1).map((e) => e.questionId);
  if (!wrong.length && !right.length) return [];

  const writes = [];

  for (const questionId of wrong) {
    writes.push(
      db.prepare(
        `INSERT INTO wrong_items
           (user_id, course_code, question_id, last_attempt_id, source, wrong_count,
            streak_correct, corrected, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, 0, 0, datetime('now'), datetime('now'))
         ON CONFLICT(user_id, question_id) DO UPDATE SET
           wrong_count = wrong_count + 1,
           streak_correct = 0,
           corrected = 0,
           last_attempt_id = excluded.last_attempt_id,
           source = excluded.source,
           updated_at = datetime('now')`
      ).bind(userId, courseCode, questionId, attemptId || null, source || 'EXAM')
    );
  }

  // 答对只影响已经在错题本里的题：连对够次数就标记订正
  for (const questionId of right) {
    writes.push(
      db.prepare(
        `UPDATE wrong_items
            SET streak_correct = streak_correct + 1,
                corrected = CASE WHEN streak_correct + 1 >= ? THEN 1 ELSE corrected END,
                updated_at = datetime('now')
          WHERE user_id = ? AND question_id = ?`
      ).bind(CORRECT_STREAK_TO_CLEAR, userId, questionId)
    );
  }

  return writes;
}
