// 每月 AI 花费上限（改进阶段 2 P1-C3）。
//
// 用户 2026-11-07 定：**到上限批改不停**（模考、练习的批改都照常）；只暂停错题分析，
// 管理员触发的出答案要点"继续"才跑。上限存在 system_settings 的 ai.monthly_budget_yuan，没有这一行 = 没设上限。
// 花了多少读 ai_spend_monthly 那一行（每次调用记账时累加，见 lib/ai.js），不每次 SUM 日志。
import { beijingMonth } from './ai.js';

export const BUDGET_KEY = 'ai.monthly_budget_yuan';

export async function budgetStatus(db, now = Date.now()) {
  const month = beijingMonth(now);
  const [b, s] = await db.batch([
    db.prepare('SELECT value FROM system_settings WHERE key = ?').bind(BUDGET_KEY),
    db.prepare('SELECT cost_yuan, calls, calls_without_price FROM ai_spend_monthly WHERE month = ?').bind(month),
  ]);
  const raw = b.results[0]?.value;
  const budget = raw == null || raw === '' ? null : Number(raw);
  if (budget !== null && !Number.isFinite(budget)) {
    // 读不懂就报错，不当"没设上限"——那会让管理员以为设了上限、实际一直在花
    const err = new Error(`每月花费上限 ${BUDGET_KEY} 读不懂：${JSON.stringify(raw)}`);
    err.code = 'bad_budget';
    throw err;
  }
  const row = s.results[0];
  const spent = Math.round(Number(row?.cost_yuan || 0) * 100) / 100;
  return {
    month,
    budget,
    spent,
    calls: Number(row?.calls || 0),
    callsWithoutPrice: Number(row?.calls_without_price || 0),
    over: budget !== null && spent >= budget,
  };
}
