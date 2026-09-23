// SET：集合比对，顺序无关，支持"从候选池任选 N 个"（§6.4.5）。
//
// 两种用法是同一个式子：
//   ① 无序并列空（B6）："天冬氨酸、谷氨酸" 两个空互换位置也全对。
//      不写 pool 时，候选池就是本组各单元的标准答案，requiredCount = 单元数，
//      于是退化成"集合相等"。
//   ② 开放列举（题干里带「等」）："含金属元素如＿、＿、＿、＿"，可接受 8 种，只填 4 个。
//      pool 列 8 种，requiredCount = 4。
//
// 命中率 = 命中的**不同**候选个数 ÷ requiredCount。多填不额外加分，填错不倒扣
// （沿用"不给部分分之外不做惩罚"的口径）。
import { fail, groupResult, groupParam } from './util.js';

/**
 * 把候选池折成 "可比写法 → 候选项" 的映射。
 * 一个候选项的多种写法（pool 里的原文 + alias 里的别名）指向同一个候选项，
 * 所以学生写 "Fe" 和 "铁" 只算命中一个，不是两个。
 */
function poolIndex(pool, alias, ctx) {
  const index = new Map();
  for (const entry of pool) {
    const forms = [entry, ...(Array.isArray(alias?.[entry]) ? alias[entry] : [])];
    for (const f of forms) {
      const key = ctx.canon(f);
      if (!key) continue;
      const owner = index.get(key);
      if (owner !== undefined && owner !== entry) {
        // 两个候选项折到同一个写法上，命中谁全看遍历顺序——那是一次静默的选择
        throw fail('pool_ambiguous',
          `候选池里 ${JSON.stringify(owner)} 与 ${JSON.stringify(entry)} 归一化之后都是 ` +
          `${JSON.stringify(key)}，判不了是命中了哪一个`);
      }
      index.set(key, entry);
    }
  }
  if (!index.size) throw fail('pool_empty', '候选池归一化之后是空的');
  return index;
}

export const setGrader = {
  strategy: 'SET',
  needsAi: false,
  gradeGroup(group, ctx) {
    const declaredPool = groupParam(group, 'pool');
    const alias = groupParam(group, 'alias');
    const pool = Array.isArray(declaredPool) && declaredPool.length
      ? declaredPool
      : group.items.flatMap((it) => [it.answer, ...it.altAnswers]).filter((a) => a != null && a !== '');
    if (!pool.length) {
      throw fail('item_without_answer',
        `单元组 ${group.key} 既没有 params.pool，各单元也没有标准答案，SET 判不了`);
    }

    const declaredCount = groupParam(group, 'requiredCount');
    const required = declaredCount === undefined ? group.items.length : Number(declaredCount);
    if (!Number.isInteger(required) || required <= 0) {
      throw fail('bad_required_count',
        `单元组 ${group.key} 的 requiredCount 是 ${JSON.stringify(declaredCount)}，要求正整数`);
    }
    if (Array.isArray(declaredPool) && required > declaredPool.length) {
      // 要填 5 个、池里只有 3 个，命中率永远上不了 1，学生怎么答都拿不到满分
      throw fail('bad_required_count',
        `单元组 ${group.key} 要填 ${required} 个，候选池只有 ${declaredPool.length} 个`);
    }

    // SET 组内各单元是可互换的，谁命中都一样值钱，所以权重必须齐平。
    // 写了不同的权重只能是配置错了；静默忽略的话，管理员以为"第一个空更重要"生效了。
    const weights = new Set(group.items.map((it) => it.weight));
    if (weights.size > 1) {
      throw fail('set_weights_uneven',
        `单元组 ${group.key} 用 SET 判定，但各单元权重不一致（${[...weights].join('、')}）：` +
        '无序并列的空之间分不出轻重，要么改权重、要么拆组');
    }

    const index = poolIndex(pool, alias, ctx);
    const claimed = new Set();
    const notes = [];
    // 逐个单元判：命中一个**还没被算过的**候选项才算数，重复填同一个不重复计分。
    // 这一步同时给出"哪个空对了"的逐项归属——前端要按空标红。
    const fractions = group.items.map((it, i) => {
      const given = ctx.canon(it.given);
      if (!given) return 0;
      const owner = index.get(given);
      if (owner === undefined) return 0;
      if (claimed.has(owner)) { notes[i] = '与前面重复，只计一次'; return 0; }
      if (claimed.size >= required) { notes[i] = `超出应答数 ${required}，不计`; return 0; }
      claimed.add(owner);
      return 1;
    });

    // 命中率的分母是 requiredCount 而不是单元数：开放列举时"给了 4 个空、可接受 8 种"，
    // 分母是 4；退化用法里单元数就等于 requiredCount，两者重合。
    return groupResult(group, fractions, {
      notes,
      rate: claimed.size / required,
      detail: { strategy: 'SET', required, hit: claimed.size, matched: [...claimed] },
    });
  },
};
