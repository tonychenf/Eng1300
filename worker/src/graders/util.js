// 判分器共用的小工具。
//
// 判分器按 **grading_strategy** 注册（需求文档 §6.4.4 末尾），跨学科共享。
// 每个判分器只回答一件事：这一组得分单元的**命中率**是多少（0～1）。
// 命中率怎么折成分数、部分分给不给、总分乘多少，全在 lib/grade.js 那唯一的循环里。
// 分开的理由：判分器一旦自己算分，"英语不给部分分"这条规则就要在八个文件里各写一遍。

export function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** 浮点求和会漂出 0.30000000000000004 这种值，落到断言和成绩单上都难看。 */
export function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

export function clamp01(n) {
  if (!Number.isFinite(n)) throw fail('bad_rate', `命中率算出来是 ${JSON.stringify(n)}`);
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * 组内加权命中率：Σ(权重 × 该单元命中比例) ÷ Σ 权重。
 *
 * B11 要求的"得分率 = 命中权重 / 总权重"就是这个式子；各单元权重相等时它退化成
 * "命中数 / 总数"。不直接写成"命中数 / 总数"，是因为权重不等时那个式子**算错了还照样
 * 返回一个像模像样的数**——3 个采分点权重 2/2/1，命中前两个，按题数算是 0.667，
 * 按权重算是 0.8，两个都是合法的得分率，没有任何地方会报错。
 */
export function weightedRate(parts) {
  let hit = 0;
  let total = 0;
  for (const p of parts) {
    const w = Number(p.weight);
    if (!Number.isFinite(w) || w <= 0) {
      throw fail('bad_item_weight',
        `得分单元 #${p.ord} 的权重是 ${JSON.stringify(p.weight)}，要求正数`);
    }
    const f = Number(p.fraction);
    if (!Number.isFinite(f) || f < 0 || f > 1) {
      throw fail('bad_rate', `得分单元 #${p.ord} 的命中比例是 ${JSON.stringify(p.fraction)}，要求 0～1`);
    }
    total += w;
    hit += w * f;
  }
  if (!(total > 0)) throw fail('bad_item_weight', '单元组的权重合计为 0，除不动');
  return clamp01(round6(hit / total));
}

/**
 * 按各单元的命中比例组装一个组判定结果。所有判分器返回同一种形状：
 *   { rate, items: [{ ord, hit, fraction, note? }] }
 * 前端"逐项对错"只写一个组件、错题本只记一种结构，靠的就是这一点（§6.4.5）。
 */
export function groupResult(group, fractions, extra = {}) {
  if (fractions.length !== group.items.length) {
    throw fail('grader_bug',
      `判分器给出 ${fractions.length} 个命中比例，单元组里有 ${group.items.length} 个单元`);
  }
  const parts = group.items.map((it, i) => ({ ord: it.ord, weight: it.weight, fraction: fractions[i] }));
  // weightedRate 照样算一遍：它顺带校验权重是不是正数、命中比例是不是 0～1。
  // extra.rate 只给 SET 这种"分母不是单元权重和"的策略用（它的分母是 requiredCount）。
  const mean = weightedRate(parts);
  return {
    rate: extra.rate === undefined ? mean : extra.rate,
    items: parts.map((p, i) => ({
      ord: p.ord,
      hit: p.fraction >= 1 ? 1 : 0,
      fraction: round6(p.fraction),
      ...(extra.notes && extra.notes[i] ? { note: extra.notes[i] } : {}),
    })),
    ...(extra.detail ? { detail: extra.detail } : {}),
  };
}

/**
 * 取整组共用的策略参数（候选池、容差、枚举集合……）。
 *
 * 参数写在单元上，但对 SET 这类整组判定的策略来说它是**组**的属性。
 * 同组两个单元写了不同的值时一律抛错，不做"取第一条"——按 ord 取第一条正是
 * CLAUDE.md 点名的高发错误：它让"配置写歪了"变成一次静默的选择。
 */
export function groupParam(group, key) {
  let found;
  let fromOrd = null;
  for (const it of group.items) {
    const v = it.params?.[key];
    if (v === undefined) continue;
    const s = JSON.stringify(v);
    if (fromOrd === null) { found = v; fromOrd = it.ord; continue; }
    if (JSON.stringify(found) !== s) {
      throw fail('group_params_conflict',
        `单元组 ${group.key} 里 #${fromOrd} 与 #${it.ord} 的 ${key} 不一致：` +
        `${JSON.stringify(found)} ≠ ${s}`);
    }
  }
  return fromOrd === null ? undefined : found;
}
