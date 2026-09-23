// NUMERIC：数值容差 + 单位（§6.4.4）。
//
// 判据只有两条：数值落在容差内，单位对得上。**不做单位换算**（280nm ≠ 0.28μm）——
// 换算要引入一张单位表并对所有学科负责，判错一次的信任代价大于省下的那点人工。
import { fail, groupResult, groupParam } from './util.js';

// 只认"数字打头、后面跟单位"这一种写法。"约 280nm"、"280 左右" 一律判未命中：
// 宁可判错记错，不可把错答放过。
const NUM_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*)$/;

// 全角数字与全角小数点是中文输入法下的常见产物，属于同一个数的不同写法，折平。
const WIDE = { '．': '.', '。': '.', '＋': '+', '－': '-', '−': '-' };
function narrow(s) {
  return String(s ?? '').trim().replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
    .replace(/[．。＋－−]/g, (c) => WIDE[c]);
}

/** "280nm" → { value: 280, unit: 'nm' }；解析不了返回 null。 */
export function parseQuantity(raw) {
  const m = NUM_RE.exec(narrow(raw));
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: m[2].trim() };
}

export const numericGrader = {
  strategy: 'NUMERIC',
  needsAi: false,
  gradeGroup(group, ctx) {
    const relDeclared = groupParam(group, 'tolerance');
    const absDeclared = groupParam(group, 'absTolerance');
    const rel = relDeclared === undefined ? ctx.grading?.numericTolerance : relDeclared;

    const notes = [];
    const fractions = group.items.map((it, i) => {
      // 标准答案解析不了是题库的错，不是学生的错，所以抛错而不是判他全班皆错
      const want = parseQuantity(it.answer);
      if (!want) {
        throw fail('numeric_answer_unparsable',
          `得分单元 #${it.ord} 的标准答案 ${JSON.stringify(it.answer)} 不是"数值[单位]"的形状`);
      }
      const got = parseQuantity(it.given);
      if (!got) { notes[i] = '不是数值'; return 0; }

      // 单位比对区分大小写：mM 与 MM 差一千倍，而 caseSensitive 那个开关管的是**词**
      // （英语拼写要不要区分大小写），拿它来管单位会把毫摩尔判成兆摩尔。
      // 学生不写单位视为沿用题干的单位（B9：标答 280nm，答 280 判对）。
      if (got.unit && got.unit !== want.unit) { notes[i] = `单位不符（要 ${want.unit || '无'}）`; return 0; }

      const diff = Math.abs(got.value - want.value);
      if (absDeclared !== undefined) {
        const abs = Number(absDeclared);
        if (!Number.isFinite(abs) || abs < 0) {
          throw fail('bad_tolerance', `得分单元 #${it.ord} 的 absTolerance 是 ${JSON.stringify(absDeclared)}`);
        }
        return diff <= abs ? 1 : 0;
      }
      if (want.value === 0) {
        // 相对容差乘 0 恒等于 0，等于悄悄变成"必须一字不差"。标准答案是 0 的题
        // 必须显式给绝对容差，否则这个单元根本没被正确配置过。
        throw fail('numeric_zero_needs_abs_tolerance',
          `得分单元 #${it.ord} 的标准答案是 0，相对容差没有意义，要在 params.absTolerance 里给绝对容差`);
      }
      const r = Number(rel);
      if (!Number.isFinite(r) || r < 0) {
        throw fail('numeric_tolerance_missing',
          `得分单元 #${it.ord} 要按数值判，但 params.tolerance 与评价标准的 grading.numericTolerance ` +
          `都取不到可用的容差（读到 ${JSON.stringify(rel)}）`);
      }
      return diff <= r * Math.abs(want.value) ? 1 : 0;
    });

    return groupResult(group, fractions, { notes, detail: { strategy: 'NUMERIC' } });
  },
};
