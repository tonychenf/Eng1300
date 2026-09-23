// AI_SCORE_POINTS：AI 逐个采分点判命中（§6.4.4、§6.6②类型 B）。
//
// 为什么拆成采分点而不是让 AI 直接打总分：它把一次主观判断拆成一组**可核对**的
// 二元判断，管理员事后能看出 AI 判错了哪个点。代价是多了一条约束——
// AI 返回的键必须与题目的采分点对得上，对不上要抛错（B12）。
//
// **这里不解析模型的原始回复。** 模型说了什么由 lib/tutor.js 的适配层读成下面这个
// 形状，读不出来它自己抛 ai_bad_shape。判分器只吃规整数据，这样它是纯函数、能用
// 构造数据测；把"猜模型想说什么"混进判分逻辑，两件事就都测不清楚了。
//
//   ctx.aiResult = { points: { "<单元 ord>": { hit, methodOk?, count?, reason? } } }
import { fail, groupResult } from './util.js';

function pointsOf(ctx, group) {
  const p = ctx.aiResult?.points;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    throw fail('ai_bad_shape',
      `单元组 ${group.key} 要按采分点判，但 AI 结果里没有 points 对象（收到 ` +
      `${ctx.aiResult === undefined ? '（未提供）' : JSON.stringify(ctx.aiResult).slice(0, 80)}）`);
  }
  return p;
}

export const aiScorePointsGrader = {
  strategy: 'AI_SCORE_POINTS',
  needsAi: true,
  gradeGroup(group, ctx) {
    const points = pointsOf(ctx, group);

    // B12：键对不上一律抛错，绝不静默记 0 分。真的没命中和没读懂模型回复，
    // 在成绩单上长得一模一样，分不开的话前者会一直被当成后者放过去。
    const missing = group.items.filter((it) => points[String(it.ord)] === undefined).map((it) => it.ord);
    const unexpected = Object.keys(points).filter((k) => !ctx.allItemOrds.has(Number(k)));
    if (missing.length || unexpected.length) {
      throw fail('ai_bad_shape',
        `AI 返回的采分点与题目对不上：缺 ${missing.length ? missing.join('、') : '无'}，` +
        `多出 ${unexpected.length ? unexpected.map((k) => JSON.stringify(k)).join('、') : '无'}；` +
        `收到的键是 ${Object.keys(points).join('、') || '（空）'}`);
    }

    const ordsHere = new Set(group.items.map((it) => it.ord));
    const hit = new Map();
    const notes = [];

    // 依赖只能指向**同组内**序号更小的单元。跨组依赖会让一个组的得分取决于另一个组，
    // 判分循环就不再是"各组独立判定"了（§6.4.5 那段伪码的前提）；解答题的几步本来
    // 就该归在一个组里。指到组外或指到后面，是内容配错了，当场说清楚。
    const ordered = [...group.items].sort((a, b) => a.ord - b.ord);
    ordered.forEach((it) => {
      const i = group.items.indexOf(it);
      const r = points[String(it.ord)] || {};
      const deps = Array.isArray(it.params?.dependsOn) ? it.params.dependsOn : [];
      for (const d of deps) {
        if (!ordsHere.has(d) || d >= it.ord) {
          throw fail('bad_depends_on',
            `得分单元 #${it.ord} 依赖 #${d}，但它不在同一个单元组里或序号不在前面` +
            `（本组是 ${[...ordsHere].join('、')}）`);
        }
      }

      // 开放采分点（G7）：不比对预设内容，AI 报"这类有效论点答出了几个"，最多计 maxCount 个
      if (it.params?.openEnded) {
        const maxCount = Number(it.params.maxCount);
        if (!Number.isInteger(maxCount) || maxCount <= 0) {
          throw fail('bad_open_ended',
            `开放采分点 #${it.ord} 的 maxCount 是 ${JSON.stringify(it.params.maxCount)}，要求正整数`);
        }
        const n = r.count;
        if (!Number.isInteger(n) || n < 0) {
          throw fail('ai_bad_shape',
            `开放采分点 #${it.ord} 要的是命中个数 count，AI 给的是 ${JSON.stringify(r)}`);
        }
        const counted = Math.min(n, maxCount);
        if (n > maxCount) notes[i] = `答出 ${n} 个，按上限计 ${maxCount} 个`;
        hit.set(it.ord, { fraction: counted / maxCount, index: i });
        return;
      }

      if (typeof r.hit !== 'boolean') {
        throw fail('ai_bad_shape',
          `采分点 #${it.ord} 的 hit 不是布尔值，收到 ${JSON.stringify(r)}`);
      }

      if (!deps.length) { hit.set(it.ord, { fraction: r.hit ? 1 : 0, index: i }); return; }

      // 依赖模式默认 METHOD_ONLY（后续过程分）：理科阅卷的通行做法是从宽。
      // 写成 STRICT 才是"前提错了结论无意义"。
      const mode = it.params.dependencyMode || 'METHOD_ONLY';
      if (mode !== 'METHOD_ONLY' && mode !== 'STRICT') {
        throw fail('bad_depends_on',
          `得分单元 #${it.ord} 的 dependencyMode 是 ${JSON.stringify(mode)}，只认 METHOD_ONLY / STRICT`);
      }
      // 带依赖的单元一律要求 AI 分别报告方法与结果。只在"前置错了"时才要，
      // 会让提示词写漏这件事一直藏到某个学生答错前一步为止。
      if (typeof r.methodOk !== 'boolean') {
        throw fail('ai_bad_shape',
          `采分点 #${it.ord} 带步骤依赖，要求 AI 分别报告 hit 与 methodOk，收到 ${JSON.stringify(r)}`);
      }
      const prereqOk = deps.every((d) => (hit.get(d)?.fraction ?? 0) >= 1);
      if (prereqOk) { hit.set(it.ord, { fraction: r.hit ? 1 : 0, index: i }); return; }
      if (mode === 'STRICT') {
        notes[i] = '前置步骤未命中，STRICT 下不给分';
        hit.set(it.ord, { fraction: 0, index: i });
        return;
      }
      if (r.methodOk) notes[i] = '前置步骤错，方法正确，给后续过程分';
      hit.set(it.ord, { fraction: r.methodOk ? 1 : 0, index: i });
    });

    return groupResult(group, group.items.map((it) => hit.get(it.ord).fraction),
      { notes, detail: { strategy: 'AI_SCORE_POINTS' } });
  },
};
