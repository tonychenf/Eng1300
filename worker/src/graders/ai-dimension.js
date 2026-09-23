// AI_DIMENSION：AI 按维度打分，加权合成（§6.4.4、§6.6②类型 A）。英语作文走这条。
//
// 加权那一行是本项目唯一的实现：lib/tutor.js 的作文批改也调这里。
// 两份实现的下场是可预见的——改了一处忘了另一处，两个入口给同一篇作文打出不同的分，
// 而两边都"成功"。
import { fail, groupResult } from './util.js';

/**
 * 维度分 → 得分率（0～1）。乘以本卷赋予该题的绝对分值才是分数。
 * 蓝本写死的那一行是 `(Σ 维度分×权重) / 6 * 30`，其中 /6 是 dimensionMax、
 * ×30 是作文满分；这里只保留前半截。
 */
export function dimensionRate(dims, scores, max) {
  const m = Number(max);
  if (!Number.isFinite(m) || m <= 0) throw fail('bad_rubric', `dimensionMax 是 ${JSON.stringify(max)}，要求正数`);
  let weighted = 0;
  for (const d of dims) {
    const v = Number(scores?.[d.key]);
    if (!Number.isFinite(v)) {
      throw fail('ai_bad_shape', `维度 ${d.key} 没有分数（收到 ${JSON.stringify(scores?.[d.key])}）`);
    }
    weighted += v * Number(d.weight);
  }
  return weighted / m;
}

export const aiDimensionGrader = {
  strategy: 'AI_DIMENSION',
  needsAi: true,
  gradeGroup(group, ctx) {
    const r = ctx.subjective;
    if (r?.type !== 'DIMENSION_WEIGHTED') {
      throw fail('rubric_not_implemented',
        `题目要按维度加权判分，但学科的主观题评价标准是 ${JSON.stringify(r?.type)}`);
    }
    const dims = Array.isArray(r.dimensions) ? r.dimensions : [];
    if (!dims.length) throw fail('bad_rubric', '维度加权评分标准里一个维度都没有');
    const rate = dimensionRate(dims, ctx.aiResult?.scores, r.dimensionMax);
    return groupResult(group, group.items.map(() => Math.max(0, Math.min(1, rate))), {
      rate: Math.max(0, Math.min(1, rate)),
      detail: { strategy: 'AI_DIMENSION', scores: ctx.aiResult?.scores },
    });
  },
};
