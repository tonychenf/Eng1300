// 首页的学习活跃度（web/src/lib/activity.js）：连续学习天数、最近 7 天、问候语都按北京时间切日子。纯 node。
// 期望值按北京时间手算（库里存世界时：北京时间 2026-11-16 00:30 = 世界时 2026-11-15 16:30）。
import { streakDays, lastSevenDays, greeting, beijingDayIndex } from '../../web/src/lib/activity.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};
// 北京时间 → 库里的世界时字符串
const db = (bj) => { const ms = Date.parse(`${bj.replace(' ', 'T')}:00Z`) - 8 * 3600 * 1000; return new Date(ms).toISOString().slice(0, 19).replace('T', ' '); };
const at = (bj) => Date.parse(`${bj.replace(' ', 'T')}:00Z`) - 8 * 3600 * 1000;   // 北京时间 → 毫秒
const NOW = at('2026-11-16 21:00');   // 星期一

console.log('== 按北京时间切日子 ==');
check('北京 00:30 和前一天 23:30 不是同一天（世界时是同一天）', beijingDayIndex(at('2026-11-16 00:30')) - beijingDayIndex(at('2026-11-15 23:30')), 1);
check('北京同一天的早晚是同一天（世界时跨了一天）', beijingDayIndex(at('2026-11-16 07:00')), beijingDayIndex(at('2026-11-16 09:00')));

console.log('== 连续学习天数 ==');
check('没有记录 → 0', streakDays([], NOW), 0);
check('今天、昨天、前天都学了 → 3', streakDays([db('2026-11-16 08:00'), db('2026-11-15 20:00'), db('2026-11-14 10:00')], NOW), 3);
check('同一天学几次只算一天', streakDays([db('2026-11-16 08:00'), db('2026-11-16 09:00'), db('2026-11-16 20:00')], NOW), 1);
check('今天还没学、昨天学了 → 连续不断（从昨天数）', streakDays([db('2026-11-15 20:00'), db('2026-11-14 10:00')], NOW), 2);
check('昨天也没学 → 0', streakDays([db('2026-11-14 10:00'), db('2026-11-13 10:00')], NOW), 0);
check('中间断一天：只数到断开处', streakDays([db('2026-11-16 08:00'), db('2026-11-15 08:00'), db('2026-11-13 08:00')], NOW), 2);
check('北京时间凌晨（世界时还是前一天）算今天', streakDays([db('2026-11-16 00:30')], NOW), 1);
check('读不懂的时间跳过', streakDays(['坏的', null, db('2026-11-16 08:00')], NOW), 1);

console.log('== 最近 7 天 ==');
const w = lastSevenDays([db('2026-11-16 08:00'), db('2026-11-16 09:00'), db('2026-11-12 10:00'), db('2026-11-09 23:00')], NOW);
check('7 天、最后一天是今天', `${w.length}/${w[6].label}/${w[6].today}`, '7/今天/true');
check('标签从早到晚：二 三 四 五 六 日 今天（今天是星期一）', w.map((d) => d.label).join(''), '二三四五六日今天');
check('每天的次数（7 天前那次不算进来）', w.map((d) => d.count), [0, 0, 1, 0, 0, 0, 2]);

console.log('== 问候 ==');
check('北京 07:00 早上好', greeting(at('2026-11-16 07:00')), '早上好');
check('北京 12:00 中午好', greeting(at('2026-11-16 12:00')), '中午好');
check('北京 15:00 下午好', greeting(at('2026-11-16 15:00')), '下午好');
check('北京 21:00 晚上好', greeting(NOW), '晚上好');
check('北京 02:00 晚上好', greeting(at('2026-11-16 02:00')), '晚上好');

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
