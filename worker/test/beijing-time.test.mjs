// 北京时间（CR-M7）单测，纯 node。
//
// 库里存世界时，显示时换北京时间（web/src/lib/time.js）；授权到期日按"北京时间那一天结束"换成世界时存
// （worker/src/lib/beijing-time.js）。期望值都是手算的常量，不拿被测函数自己去算期望。
//
// 最后扫一遍页面源码：直接显示 xxx_at / xxxAt、或者对它 slice 的地方都算违规——以前就是这样 12 处
// 各自原样显示世界时。新加的页面忘了走 formatBeijing，这里会红。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDbTime, formatBeijing, beijingDate } from '../../web/src/lib/time.js';
import { expiryToUtc, utcToBeijing } from '../src/lib/beijing-time.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};
const throws = (desc, fn, wantCode) => {
  let code = null;
  try { fn(); } catch (e) { code = e.code || '（没有 code）'; }
  if (code === wantCode) pass++;
  else { fail++; console.log(`  FAIL ${desc} (期望抛 ${wantCode}, 实际 ${code})`); }
};

console.log('== 库里的世界时 → 北京时间 ==');
check('SQLite 的 datetime 按世界时读', parseDbTime('2026-10-01 07:00:00'), Date.UTC(2026, 9, 1, 7, 0, 0));
check('下午 3 点开始的考试显示下午 3 点（不是早上 7 点）', formatBeijing('2026-10-01 07:00:00'), '2026-10-01 15:00');
check('跨零点：世界时前一天 16:30 是北京时间第二天 00:30', formatBeijing('2026-09-30 16:30:00'), '2026-10-01 00:30');
check('跨年', formatBeijing('2025-12-31 16:00:00'), '2026-01-01 00:00');
check('跨到闰日', formatBeijing('2024-02-28 16:00:00'), '2024-02-29 00:00');
check('带毫秒', formatBeijing('2026-10-01 07:00:00.123'), '2026-10-01 15:00');
check('带 Z 的 ISO（导出接口的 exportedAt）', formatBeijing('2026-10-01T07:00:00Z'), '2026-10-01 15:00');
check('带 +08:00 的 ISO 不重复加 8 小时', formatBeijing('2026-10-01T15:00:00+08:00'), '2026-10-01 15:00');
check('空值给占位', formatBeijing(null), '—');
check('空值给指定的占位', formatBeijing('', '从未登录'), '从未登录');
check('读不懂的原样显示，不吞掉', formatBeijing('上周'), '上周');
check('只要日期：北京时间当天最后一秒', beijingDate('2026-10-01 15:59:59'), '2026-10-01');
check('只要日期：再过一秒就是北京时间第二天', beijingDate('2026-10-01 16:00:00'), '2026-10-02');
check('只要日期：空值', beijingDate(null), '');

console.log('== 授权到期日：北京时间那一天结束 → 库里存的世界时 ==');
check('选 10 月 1 日：北京时间 23:59:59 = 世界时 15:59:59', expiryToUtc('2026-10-01'), '2026-10-01 15:59:59');
check('旧页面发来的 "日期 23:59:59" 也按北京时间理解', expiryToUtc('2026-10-01 23:59:59'), '2026-10-01 15:59:59');
check('空 = 长期', expiryToUtc(''), null);
check('null = 长期', expiryToUtc(null), null);
throws('不存在的日期', () => expiryToUtc('2026-02-30'), 'invalid_expires_at');
throws('带别的时刻', () => expiryToUtc('2026-10-01 08:00:00'), 'invalid_expires_at');
throws('ISO 写法', () => expiryToUtc('2026-10-01T00:00:00Z'), 'invalid_expires_at');
throws('看不懂的', () => expiryToUtc('明天'), 'invalid_expires_at');
check('管理员选哪天，界面上就显示哪天到期', beijingDate(expiryToUtc('2026-10-01')), '2026-10-01');
check('到期提示里的时间是北京时间', utcToBeijing('2026-10-01 15:59:59'), '2026-10-01 23:59');
check('到期提示跨零点', utcToBeijing('2026-10-01 16:00:00'), '2026-10-02 00:00');
check('到期提示读不懂的原样返回', utcToBeijing('?'), '?');

console.log('== 页面里不许直接显示世界时 ==');
const RULES = [
  [/\{\s*[\w.?]+(?:_at|At)\s*\}/, 'JSX 里直接显示'],
  [/\$\{\s*[\w.?]+(?:_at|At)\b[^}]*\}/, '模板字符串里直接拼'],
  [/[\w?]+(?:_at|At)\??\.slice\(/, '对时间字符串 slice'],
];
const found = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(jsx|js)$/.test(e.name) && !p.endsWith(path.join('lib', 'time.js'))) {
      fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        for (const [re, why] of RULES) {
          if (re.test(line)) found.push(`${path.relative(root, p)}:${i + 1}（${why}）${line.trim().slice(0, 80)}`);
        }
      });
    }
  }
};
walk(path.join(root, 'web/src'));
found.forEach((f) => console.log(`     ${f}`));
check('直接显示世界时的地方（应该经过 formatBeijing / beijingDate）', found.length, 0);

console.log(`== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
