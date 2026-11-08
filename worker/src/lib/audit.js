// 后台操作审计（改进阶段 2，表在迁移 0019）。
//
// 两种用法：
//   - auditStmt：和主操作放进同一个 batch（建学科、改模板这类"要么全成要么全不成"的）；
//   - audit：主操作已经落库之后单独记一笔（一键发布、一键开通这类分批做的）。写失败吞掉并告警——
//     记账类写入失败不能改变用户要的那个结果（CLAUDE.md 三"处理错误时"）。
export function auditStmt(db, { actorId, action, subjectId = null, target = null, before = null, after = null }) {
  return db.prepare(
    `INSERT INTO admin_audit (actor_id, action, subject_id, target, before_json, after_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(actorId ?? null, action, subjectId, target,
    before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after));
}

export async function audit(db, entry) {
  try {
    await auditStmt(db, entry).run();
  } catch (e) {
    console.warn(`审计写入失败（${entry.action}）：`, String(e?.message || e).slice(0, 200));
  }
}
