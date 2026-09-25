// AI 用途清单的单测（N7d）。
//
// 这份清单存在两个地方，而且注定要存在两个地方：JS 侧的 lib/ai-purposes.js，
// 和 SQL 侧 ai_settings 的 CHECK（SQL 没法 import JS）。**两边漂了不会报错**——
// JS 放行的值被库里的 CHECK 拒掉，接口返回 500，而看代码完全看不出问题。
// 所以这里把迁移文件读出来，逐字比对。
import { readFileSync } from 'node:fs';
import {
  AI_PURPOSES, PURPOSE_CODES, isPurpose, purposeChain, purposeMeta, purposeForMedia,
} from '../src/lib/ai-purposes.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};

console.log('== JS 侧与迁移里的 CHECK 必须逐字一致 ==');
const sql = readFileSync(new URL('../migrations/0002_bank.sql', import.meta.url), 'utf8');
const m = sql.match(/purpose TEXT NOT NULL CHECK \(purpose IN \(([^)]*)\)\)/);
check('迁移里找得到 purpose 的 CHECK', Boolean(m), true);
const inSql = (m?.[1] || '').split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
check('CHECK 里的取值与 PURPOSE_CODES 一致（顺序也一致）',
  inSql.join('|'), PURPOSE_CODES.join('|'));

console.log('\n== 重建脚本建出来的新表也要是同一份清单 ==');
// 漏了这条的话：新库（走迁移）认识 TEXT_PARSING，线上库（走重建）不认识，
// 而本地测试永远是新库，全绿；线上插不进去，报的是 CHECK 约束失败。
const rebuild = readFileSync(
  new URL('../../scripts/ci/rebuild/ai_settings_purposes.sql', import.meta.url), 'utf8');
const rm = rebuild.match(/purpose TEXT NOT NULL CHECK \(purpose IN \(([^)]*)\)\)/);
const inRebuild = (rm?.[1] || '').split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
check('重建脚本里的取值与 PURPOSE_CODES 一致', inRebuild.join('|'), PURPOSE_CODES.join('|'));

console.log('\n== 回落链 ==');
check('图片解析是链的终点', purposeChain('PARSING').join('>'), 'PARSING');
check('文字解析没配时回落到图片解析',
  purposeChain('TEXT_PARSING').join('>'), 'TEXT_PARSING>PARSING');
// 教学侧全是文字活，先找文字模型；两档都没配时退回原来的行为，升级不改变既有装机
check('教学先找文字解析，再回落到图片解析',
  purposeChain('TUTORING').join('>'), 'TUTORING>TEXT_PARSING>PARSING');
check('不认识的用途不会炸，返回它自己', purposeChain('NOPE').join('>'), 'NOPE');
// 回落链里每一档都必须是合法取值，否则会去查一个库里根本不可能有的 purpose
for (const p of AI_PURPOSES) {
  check(`${p.code} 的回落链每一档都合法`,
    purposeChain(p.code).every((x) => isPurpose(x)), true);
}
check('回落链不会绕成环（有终点）',
  AI_PURPOSES.every((p) => purposeChain(p.code).at(-1) === 'PARSING'), true);

console.log('\n== 按资料形态选档 ==');
check('图片型走图片解析', purposeForMedia('image'), 'PARSING');
check('文字型走文字解析', purposeForMedia('text'), 'TEXT_PARSING');
// 管线没声明 mediaKind 时按文字算：文字档回落得到图片档，反过来不成立，
// 猜错方向的代价是拿视觉模型跑文字（贵但能跑）而不是拿文本模型读图（直接废）
check('没声明时按文字算（猜错方向的代价小）', purposeForMedia(undefined), 'TEXT_PARSING');

console.log('\n== 只有图片解析那档要求读图 ==');
check('图片解析要求 vision', purposeMeta('PARSING').needsVision, true);
check('文字解析不要求 vision', purposeMeta('TEXT_PARSING').needsVision, false);
check('教学不要求 vision', purposeMeta('TUTORING').needsVision, false);
check('不认识的用途返回 null', purposeMeta('NOPE'), null);

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
