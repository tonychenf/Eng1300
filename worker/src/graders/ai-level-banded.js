// AI_LEVEL_BANDED：整体落档评分（§6.6②类型 C）。申论、大作文这类拆维度也拆不出
// 采分点的题用。
//
// 顺序不能反：**先选档、再在档内给分、并给出落档理由**。让 AI 直接打一个分，
// 它会给中庸的分数；先落档，档次描述就约束了它的判断，而落档理由可以被人工抽查。
//
// §6.4.4 那张策略表是 v2.1 写的，那时还没有类型 C，所以表里没有这一格。
// 补上它是因为：一种评价标准如果没有对应的判分策略，学科声明了也走不到判分。
import { fail, groupResult } from './util.js';

export const aiLevelBandedGrader = {
  strategy: 'AI_LEVEL_BANDED',
  needsAi: true,
  gradeGroup(group, ctx) {
    const r = ctx.subjective;
    if (r?.type !== 'LEVEL_BANDED') {
      throw fail('rubric_not_implemented',
        `题目要按档次判分，但学科的主观题评价标准是 ${JSON.stringify(r?.type)}`);
    }
    const bands = Array.isArray(r.bands) ? r.bands : [];
    if (!bands.length) throw fail('bad_rubric', '分档评分标准里一个档次都没有');
    const total = Number(r.totalScore ?? r.total_score);
    if (!Number.isFinite(total) || total <= 0) throw fail('bad_rubric', `分档评分的 totalScore 是 ${JSON.stringify(total)}`);

    const ai = ctx.aiResult || {};
    const band = bands.find((b) => String(b.level) === String(ai.level));
    if (!band) {
      throw fail('ai_bad_shape',
        `AI 给的档次 ${JSON.stringify(ai.level)} 不在标准里（有 ${bands.map((b) => b.level).join('、')}）`);
    }
    if (r.requireReason && !String(ai.reason || '').trim()) {
      // 光秃秃一个分数没法抽查，等于又回到"AI 凭印象打分"
      throw fail('ai_bad_shape', `落档评分要求给出理由，AI 只给了分数（档 ${band.level}）`);
    }
    const score = Number(ai.score);
    if (!Number.isFinite(score)) {
      throw fail('ai_bad_shape', `AI 没给出可用的分数（收到 ${JSON.stringify(ai.score)}）`);
    }
    const [lo, hi] = Array.isArray(band.range) ? band.range : [];
    if (!Number.isFinite(Number(lo)) || !Number.isFinite(Number(hi))) {
      throw fail('bad_rubric', `档次 ${band.level} 的 range 是 ${JSON.stringify(band.range)}`);
    }
    if (score < Number(lo) || score > Number(hi)) {
      // 不夹到区间里：档次与分数是两个互相矛盾的信号，挑一个信就是猜。
      // 夹一下看着很体面，但"AI 说四类文却给了 19 分"这种事会就此没人知道。
      throw fail('ai_bad_shape',
        `AI 选了档 ${band.level}（${band.name || ''} ${lo}～${hi} 分）却给了 ${score} 分，两者对不上`);
    }

    const rate = score / total;
    return groupResult(group, group.items.map(() => Math.max(0, Math.min(1, rate))), {
      rate: Math.max(0, Math.min(1, rate)),
      detail: { strategy: 'AI_LEVEL_BANDED', level: band.level, band: band.name, score, reason: ai.reason || '' },
    });
  },
};
