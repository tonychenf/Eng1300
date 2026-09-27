// 组卷限流（CR-M1）。
//
// 组一份模拟卷要写约 52 行（1 条考试记录 + 51 条题目行），D1 免费版每天 10 万行写入。
// 不限的话一个学员连点约 1,900 次就能把全站当天的写入额度耗光——之后所有人都交不了卷，
// 要等到北京时间早上八点。
//
// 计数直接查已有的考试记录，只读不写：不能为了防人刷写入额度，先自己花掉写入额度。
// 阈值是系统参数（学科可覆盖），后台「系统参数」里能改；取不到就抛错，不给代码兜底值
// （兜底值往往恰好等于种子里那个数，"这行参数没了"会被伪装成"就是这么配的"）。
// AI 评估不限（用户决定）。
import { settingInt } from './subject-pack.js';

/** 超限时返回 { error, message }，没超限返回 null。管理员不走这里。 */
export async function examRateLimited(db, userId, subjectId) {
  const perMinute = await settingInt(db, subjectId, 'limit.exam_per_minute');
  const perDay = await settingInt(db, subjectId, 'limit.exam_per_day');
  const row = await db.prepare(
    `SELECT COALESCE(SUM(started_at > datetime('now', '-1 minute')), 0) AS last_minute,
            COUNT(*) AS last_day
       FROM attempts
      WHERE user_id = ? AND mode = 'EXAM' AND started_at > datetime('now', '-1 day')`
  ).bind(userId).first();
  if (row.last_minute >= perMinute) {
    return { error: 'rate_limited', message: `组卷太频繁了：每分钟最多 ${perMinute} 份，请稍等一会儿再试` };
  }
  if (row.last_day >= perDay) {
    return { error: 'rate_limited', message: `24 小时内最多组 ${perDay} 份模拟卷，已经到上限了，明天再来` };
  }
  return null;
}
