// 教学 AI 的四类调用（PRD §10.2）。
//
// 提示词与评分标准全部来自学科能力包，这个文件只剩调用骨架：
//   系统提示词、四类用户提示词模板 → subject_ai_prompts（学科 → 全局兜底）
//   作文维度、权重、满分            → subject_rubrics.payload.essay
//
// 蓝本这里写死的是英语：SYS 里写着"中国自学考试英语科目"，五维权重
// content 0.30 + language 0.25 + vocabulary 0.15 + coherence 0.20 + length 0.10
// 直接写在合成总分的那一行里。拿这套去批改生化的问答，会给出一个按"词汇丰富度"
// 打出来的分数，而系统一切正常。
//
// 统一约定：全部走 chatJSON（内部已带 enable_thinking:false 与 JSON 强约束，
// 解析失败自动重试一次）。任何一类失败都只影响自己那一块，不能拖垮判分与记录
// （PRD §10.3）。
import { chatJSON } from './ai.js';
import { promptFor, renderTemplate } from './subject-pack.js';
import { dimensionRate } from '../graders/index.js';
import { stemForAi } from './stem-assets.js';

function bad(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** 取该学科该功能的系统提示词与模板。取不到会抛错，不会拿空串去问模型。 */
async function prompts(env, pack, feature) {
  return promptFor(env.DB, pack.subjectId, feature);
}

/**
 * 校验作文 rubric 并算出提示词要用的两段文本。
 * 权重和不等于 1 要当场拒绝：管理员把权重改成合计 1.2 之后，分数会整体虚高 20%，
 * 而批改照常"成功"，没有任何地方会报错。
 */
function essayRubric(pack) {
  const r = pack.rubric.essay;
  if (r.type !== 'DIMENSION_WEIGHTED') {
    // 采分点命中式（POINT_HIT）的判分在 N5。分派不到就抛错，不退回维度加权——
    // 退回的后果是生化的主观题被按英语作文的维度打分，分数看着很正常。
    throw bad('rubric_not_implemented',
      `学科 ${pack.code} 的作文评分标准是 ${r.type}，这一版只实现了 DIMENSION_WEIGHTED`);
  }
  const dims = Array.isArray(r.dimensions) ? r.dimensions : [];
  if (!dims.length) throw bad('bad_rubric', `学科 ${pack.code} 的作文评分标准没有任何维度`);
  const max = Number(r.dimensionMax);
  const full = Number(r.totalScore);
  if (!Number.isFinite(max) || max <= 0) throw bad('bad_rubric', 'dimensionMax 不是正数');
  if (!Number.isFinite(full) || full <= 0) throw bad('bad_rubric', 'totalScore 不是正数');
  const sum = dims.reduce((a, d) => a + Number(d.weight || 0), 0);
  if (Math.abs(sum - 1) > 0.001) {
    throw bad('bad_rubric', `作文维度权重合计是 ${sum.toFixed(3)}，应当为 1`);
  }
  const keys = dims.map((d) => d.key);
  if (new Set(keys).size !== keys.length) throw bad('bad_rubric', '作文维度的 key 有重复');

  const dimensionLines =
    `${dims.length} 个维度各打 0 到 ${max} 分（可给小数，一位小数）：\n` +
    dims.map((d) => `- ${d.key} ${d.name}：${d.hint || ''}`).join('\n');
  const jsonShape =
    '{' + keys.map((k) => `"${k}":0`).join(',') + ',\n' +
    ' "comments":{' + keys.map((k) => `"${k}":""`).join(',') + '},\n' +
    ' "suggestions":["","",""]}';
  return { dims, keys, max, full, dimensionLines, jsonShape };
}

/** 主观题批改。维度、权重、满分全部来自 rubric。 */
export async function gradeEssay(env, pack, { prompt, essay }) {
  const R = essayRubric(pack);
  const { systemPrompt, userTemplate } = await prompts(env, pack, 'essay_grade');

  const { data } = await chatJSON(env, {
    purpose: 'TUTORING',
    feature: 'essay_grade',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: renderTemplate(userTemplate, {
          subjectName: pack.name,
          prompt: prompt || '（原卷未提供写作要求）',
          essay,
          dimensionLines: R.dimensionLines,
          jsonShape: R.jsonShape,
        }),
      },
    ],
  });

  // 取维度分要宽容一点，但读不到必须报错，不能悄悄记 0 分。
  //
  // 线上实测踩到过：真实模型返回的 JSON 合法，键名却不是我们要的那套，维度
  // 全都取不到，一律回落 0，于是作文被判 0 分、状态还是"批改成功"。学生看到的是
  // 一个理直气壮的零分，没人知道其实是没读懂模型的回复。替身按我们要的形状返回，
  // 所以本地永远发现不了。
  const nested = [data, data.scores, data.score, data.result, data.dimensions]
    .filter((o) => o && typeof o === 'object');
  const readDim = (k) => {
    for (const obj of nested) {
      const raw = obj[k];
      if (raw === undefined || raw === null) continue;
      const v = typeof raw === 'number' ? raw : Number(String(raw).match(/-?\d+(\.\d+)?/)?.[0]);
      if (Number.isFinite(v)) return Math.max(0, Math.min(R.max, v));
    }
    return null;
  };
  const found = Object.fromEntries(R.keys.map((k) => [k, readDim(k)]));
  if (R.keys.every((k) => found[k] === null)) {
    throw bad('ai_bad_shape',
      `模型返回里找不到任何维度分，顶层键为 ${Object.keys(data).join(',') || '（空）'}`);
  }
  const scores = Object.fromEntries(R.keys.map((k) => [k, found[k] ?? 0]));
  // 加权那一步走判分器注册表里的 AI_DIMENSION，不在这儿另写一遍：
  // 两份实现改一处忘一处，同一篇作文在两个入口会出两个分，而两边都"成功"。
  const total = Math.round(dimensionRate(R.dims, scores, R.max) * R.full * 10) / 10;

  return {
    scores,
    total,
    rubricVersion: pack.rubricVersion,
    comments: data.comments && typeof data.comments === 'object' ? data.comments : {},
    suggestions: Array.isArray(data.suggestions) ? data.suggestions.slice(0, 3) : [],
  };
}

/** 错题分析：错因 + 记忆要点 */
export async function analyzeWrong(env, pack, { stem, options, userAnswer, correctAnswer, knowledgePoints, passage, assets }) {
  const { systemPrompt, userTemplate } = await prompts(env, pack, 'wrong_analyze');
  const { data } = await chatJSON(env, {
    purpose: 'TUTORING',
    feature: 'wrong_analyze',
    maxTokens: 800,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: renderTemplate(userTemplate, {
          subjectName: pack.name,
          passageBlock: passage ? `原文片段：\n${String(passage).slice(0, 1200)}\n\n` : '',
          // 图片引用换成 [图：alt] 再发给模型（§6.4.6、G3）。AI 看不到图，
          // 原样发 ![fig1] 它会照着残缺题干编一段解析；删掉更糟——连“这里有张图”
          // 都不剩了。没有图的题这一步原样返回。
          stem: stemForAi(stem, assets),
          optionsBlock: options?.length ? `选项：${options.join(' | ')}\n` : '',
          userAnswer: userAnswer || '（未作答）',
          correctAnswer,
          knowledgePoints: (knowledgePoints || []).join('、') || '未标注',
        }),
      },
    ],
  });
  return {
    errorReason: String(data.errorReason || '').slice(0, 300),
    memoryPoint: String(data.memoryPoint || '').slice(0, 300),
  };
}

/** 答案解读：练习即时反馈用 */
export async function explainAnswer(env, pack, { stem, options, userAnswer, correctAnswer, isCorrect, passage, assets }) {
  const { systemPrompt, userTemplate } = await prompts(env, pack, 'answer_explain');
  const { data } = await chatJSON(env, {
    purpose: 'TUTORING',
    feature: 'answer_explain',
    maxTokens: 800,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: renderTemplate(userTemplate, {
          subjectName: pack.name,
          passageBlock: passage ? `原文片段：\n${String(passage).slice(0, 1200)}\n\n` : '',
          // 图片引用换成 [图：alt] 再发给模型（§6.4.6、G3）。AI 看不到图，
          // 原样发 ![fig1] 它会照着残缺题干编一段解析；删掉更糟——连“这里有张图”
          // 都不剩了。没有图的题这一步原样返回。
          stem: stemForAi(stem, assets),
          optionsBlock: options?.length ? `选项：${options.join(' | ')}\n` : '',
          userAnswer: userAnswer || '（未作答）',
          correctAnswer,
          correctness: isCorrect ? '答对了' : '答错了',
        }),
      },
    ],
  });
  return String(data.explanation || '').slice(0, 600);
}

/** 能力评估的定性层 */
export async function assessAbility(env, pack, { mastery, recentWrongTags, scoreTrend, totalScore }) {
  const { systemPrompt, userTemplate } = await prompts(env, pack, 'assessment');
  const fullScore = Number(pack.rubric.fullScore);
  if (!Number.isFinite(fullScore) || fullScore <= 0) {
    throw bad('bad_rubric', `学科 ${pack.code} 的评价标准里 fullScore 不是正数`);
  }
  const { data } = await chatJSON(env, {
    purpose: 'TUTORING',
    feature: 'assessment',
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: renderTemplate(userTemplate, {
          subjectName: pack.name,
          fullScore,
          masteryLines: mastery.map((m) =>
            `${m.name}：做过 ${m.total} 题，正确 ${m.correct} 题，档位 ${m.tier}`).join('\n') || '暂无数据',
          recentWrongTags: recentWrongTags.join('、') || '暂无',
          scoreTrend: scoreTrend.join('、') || '暂无',
          predictedScore: totalScore ?? '样本不足',
        }),
      },
    ],
  });
  const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  return {
    predictedLow: num(data.predictedLow),
    predictedHigh: num(data.predictedHigh),
    levelDesc: String(data.levelDesc || '').slice(0, 200),
    weakPoints: Array.isArray(data.weakPoints) ? data.weakPoints.slice(0, 5) : [],
    suggestions: Array.isArray(data.suggestions) ? data.suggestions.slice(0, 3) : [],
  };
}
