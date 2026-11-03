// 判分落库的写入守卫：「先读状态、再写」的接口，把判断挪进写入语句自己。
//
// 交卷、练习交答案、保存作答都是先读一次（"还在作答吗""这道题答过没有"），判完分再一个 batch 写进去。
// 读和写之间隔着好几次查库，几个请求同时到时（两个标签页、超时自动交卷撞上手动交卷、手快连点两下）
// 都读到"可以写"，于是错题次数、掌握度各累计好几遍。以前只有更新考试状态那一句带着
// status = '进行中'，同一批里别的语句不带。
//
// D1 的 batch 是一个事务，几个 batch 一个接一个执行。所以：每条写入都带上同一个条件，
// **把让条件失效的那一句（改状态、写作答记录）排在 batch 最后**——先到的 batch 写完，
// 后到的 batch 里每一句的条件都不成立，整批什么也不写。调用方看最后一句的 meta.changes
// 就知道自己是不是先到的那个。
//
// 掌握度、错题本的写入函数把守卫当必填参数：没有"不带守卫"的那一种 SQL，
// 免得哪个新调用方漏了它也照样能跑（两套 SQL 里那套没人走的，坏了也没人知道）。

/** 这次作答（模考或练习）还在进行中。 */
export function attemptOpenGuard(attemptId) {
  return {
    sql: "(EXISTS (SELECT 1 FROM attempts WHERE attempt_id = ? AND status = '进行中'))",
    binds: [attemptId],
  };
}

/**
 * 练习：还在进行中，并且这道题还没有判出对错的作答记录。
 * is_correct 为空的记录不算"答过"：要 AI 判的题（生化名词解释、问答）练习里判不出对错，可以重答。
 */
export function practiceAnswerGuard(attemptId, questionId) {
  const open = attemptOpenGuard(attemptId);
  return {
    sql: `(${open.sql} AND NOT EXISTS (SELECT 1 FROM answer_records
            WHERE attempt_id = ? AND question_id = ? AND is_correct IS NOT NULL))`,
    binds: [...open.binds, attemptId, questionId],
  };
}

export function requireGuard(guard, who) {
  if (!guard || typeof guard.sql !== 'string' || !Array.isArray(guard.binds)) {
    throw new Error(`${who}: 缺少写入守卫（{ sql, binds }，见 lib/write-guard.js）`);
  }
}

/** batch 里最后一句（让守卫失效的那句）真的写了一行，说明这次是先到的那个。 */
export function lastWriteLanded(results) {
  const last = results[results.length - 1];
  const changes = last?.meta?.changes;
  if (typeof changes !== 'number') {
    // 读不到就抛错，不当成"没写"：那会把一次成功的交卷报成"已经交过了"
    throw new Error(`batch 结果里读不到最后一句的 meta.changes（收到 ${JSON.stringify(last?.meta ?? last)}）`);
  }
  return changes > 0;
}
