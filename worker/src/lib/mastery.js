// 考点掌握度：连续答对次数与最近结果。
// 模考交卷和练习答题都走这里，保证两边口径一致。
//
// M3 那版只累计了对错次数，consecutive_correct 一直留 0——当时还没人用它。
// M4 的强化阶段要按它定抽题权重，所以这里补齐。

// 阈值与权重来自能力包的 rubric.mastery（蓝本把它们写死在下面两个函数里）。
// 读不到就抛错，不给默认值：默认值恰好等于英语那套，于是新学科会悄悄套用英语的
// 掌握判定，而报告上一切正常。
function need(cfg, path) {
  let v = cfg;
  for (const k of path.split('.')) v = v?.[k];
  if (v === undefined || v === null) {
    const err = new Error(`bad_rubric: 评价标准的 mastery 段缺少 ${path}`);
    err.code = 'bad_rubric';
    throw err;
  }
  return v;
}

/** PRD §7.3 掌握度档位。m = pack.rubric.mastery */
export function masteryTier(row, m) {
  const total = (row.correct_count || 0) + (row.wrong_count || 0);
  if (total === 0) return '未测';
  if (row.last_result === 'wrong') return '薄弱';
  if (total >= need(m, 'masteredMinTotal') && (row.consecutive_correct || 0) >= need(m, 'masteredMinStreak')) {
    return '已掌握';
  }
  const recentRate = total ? (row.correct_count || 0) / total : 0;
  if (recentRate < need(m, 'weakRateBelow')) return '薄弱';
  return '待巩固';
}

/**
 * PRD §7.2 强化阶段的抽取权重。答对也永不归零，用来复验"蒙对"的考点。
 * m = pack.rubric.mastery；byStreak 是个梯子，upTo 为 null 的那档兜底，必须排在最后。
 */
export function tagWeight(row, m) {
  const w = need(m, 'weights');
  const total = row ? (row.correct_count || 0) + (row.wrong_count || 0) : 0;
  if (!row || total === 0) return need(w, 'untested');
  if (row.last_result === 'wrong') return need(w, 'lastWrong');
  const streak = row.consecutive_correct || 0;
  const ladder = need(w, 'byStreak');
  for (const step of ladder) {
    if (step.upTo === null || step.upTo === undefined || streak <= step.upTo) return step.weight;
  }
  const err = new Error(`bad_rubric: byStreak 梯子没有兜底档（最后一档的 upTo 要写成 null），连对 ${streak} 次落不到任何一档`);
  err.code = 'bad_rubric';
  throw err;
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
