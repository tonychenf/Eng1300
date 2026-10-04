// 成绩报告"各部分得分"的重算。
//
// 交卷时这一份由判分结果现算（routes/exam.js 的 submitAttempt），写进 attempts.section_scores。
// AI 批改是交卷之后另一个请求做的，以前批完只补了总分、没重算这一份：作文、主观题批完了，
// 报告上那几部分还写着"待批改"，总分却已经变了。所以批改完按库里的最新分数重算。
//
// 形状和口径跟交卷时那一份一模一样（同一个部分的分数按题号顺序累加，不另外取整），
// bio-exam.sh 拿批改前后两份比对：没有 AI 题的部分必须逐字段相等。
export async function sectionScoresFromDb(db, attemptId, pack) {
  const { results } = await db.prepare(
    `SELECT aq.section_ord, aq.score_per_question, q.question_type, s.type AS section_type,
            r.score, r.is_correct, r.ai_judged
       FROM attempt_questions aq
       JOIN questions q ON q.question_id = aq.question_id
       JOIN sections s ON s.section_id = aq.section_id
       LEFT JOIN answer_records r ON r.attempt_id = aq.attempt_id AND r.question_id = aq.question_id
      WHERE aq.attempt_id = ?
      ORDER BY aq.ord`
  ).bind(attemptId).all();

  const bySection = new Map();
  for (const row of results) {
    let sec = bySection.get(row.section_ord);
    if (!sec) {
      sec = {
        sectionOrd: row.section_ord, sectionType: row.section_type,
        score: 0, maxScore: 0, correct: 0, total: 0, pendingAi: 0,
      };
      bySection.set(row.section_ord, sec);
    }
    sec.total++;
    sec.maxScore += row.score_per_question;
    if (row.score !== null && row.score !== undefined) sec.score += row.score;
    if (row.is_correct === 1) sec.correct++;
    // 要 AI 的题以"批没批过"为准：英语作文批完 is_correct 仍是 NULL（作文不分对错），
    // 按 is_correct 判的话它永远算待批改。不要 AI 的题照交卷时的口径：判不出对错的算待判。
    const needsAi = pack.typeOf(row.question_type).needsAi;
    if (needsAi ? !row.ai_judged : row.is_correct === null) sec.pendingAi++;
  }
  return [...bySection.values()].sort((a, b) => a.sectionOrd - b.sectionOrd);
}
