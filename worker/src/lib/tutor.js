// 教学 AI 的四类调用（PRD §10.2）。
//
// 统一约定：全部走 chatJSON（内部已带 enable_thinking:false 与 JSON 强约束，
// 解析失败自动重试一次）。任何一类失败都只影响自己那一块，不能拖垮判分与记录——
// 这是 PRD §10.3 的核心原则。
import { chatJSON } from './ai.js';

const SYS = '你是一位中国自学考试英语科目的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。';

/** 作文批改：五个维度各 0–6 分，加权合成 30 分制（PRD §7.4） */
export async function gradeEssay(env, { prompt, essay }) {
  const { data } = await chatJSON(env, {
    purpose: 'TUTORING',
    feature: 'essay_grade',
    messages: [
      { role: 'system', content: SYS },
      {
        role: 'user',
        content: `按下面的评分标准批改这篇自考英语作文。

写作要求：
${prompt || '（原卷未提供写作要求）'}

学生作文：
${essay}

五个维度各打 0 到 6 分（可给小数，一位小数）：
- content 内容要点覆盖：是否覆盖题目给出的全部中文写作要点
- language 语言准确性：语法、时态、搭配错误的密度
- vocabulary 词汇丰富度：用词多样性与准确性
- coherence 篇章连贯性：逻辑衔接、段落组织
- length 字数达标：100 词左右；低于 70 或高于 150 明显扣分

只输出这个 JSON：
{"content":0,"language":0,"vocabulary":0,"coherence":0,"length":0,
 "comments":{"content":"","language":"","vocabulary":"","coherence":"","length":""},
 "suggestions":["","",""]}`,
      },
    ],
  });

  // 取维度分要宽容一点，但读不到必须报错，不能悄悄记 0 分。
  //
  // 线上实测踩到过：真实模型返回的 JSON 合法，键名却不是我们要的那套，五个维度
  // 全都取不到，dim() 一律回落 0，于是作文被判 0 分、状态还是"批改成功"。
  // 学生看到的是一个理直气壮的零分，没人知道其实是没读懂模型的回复。替身按我们
  // 要的形状返回，所以本地永远发现不了。
  //
  // 现在：顶层没有就往 scores / result 这类常见嵌套里找；数字写成 "5.5" 或
  // "5.5分" 也认。一个维度都取不到就抛 ai_bad_shape，按失败处理、可重试。
  const nested = [data, data.scores, data.score, data.result, data.dimensions]
    .filter((o) => o && typeof o === 'object');
  const readDim = (k) => {
    for (const obj of nested) {
      const raw = obj[k];
      if (raw === undefined || raw === null) continue;
      const v = typeof raw === 'number' ? raw : Number(String(raw).match(/-?\d+(\.\d+)?/)?.[0]);
      if (Number.isFinite(v)) return Math.max(0, Math.min(6, v));
    }
    return null;
  };
  const KEYS = ['content', 'language', 'vocabulary', 'coherence', 'length'];
  const found = Object.fromEntries(KEYS.map((k) => [k, readDim(k)]));
  if (KEYS.every((k) => found[k] === null)) {
    const err = new Error(`ai_bad_shape: 模型返回里找不到任何维度分，顶层键为 ${Object.keys(data).join(',') || '（空）'}`);
    err.code = 'ai_bad_shape';
    throw err;
  }
  const scores = Object.fromEntries(KEYS.map((k) => [k, found[k] ?? 0]));
  // 权重来自 PRD §7.4，六分制按权重合成到 30 分
  const weighted =
    scores.content * 0.30 + scores.language * 0.25 + scores.vocabulary * 0.15 +
    scores.coherence * 0.20 + scores.length * 0.10;
  const total = Math.round((weighted / 6) * 30 * 10) / 10;

  return {
    scores,
    total,
    comments: data.comments && typeof data.comments === 'object' ? data.comments : {},
    suggestions: Array.isArray(data.suggestions) ? data.suggestions.slice(0, 3) : [],
  };
}

/** 错题分析：错因 + 记忆要点 */
export async function analyzeWrong(env, { stem, options, userAnswer, correctAnswer, knowledgePoints, passage }) {
  const { data } = await chatJSON(env, {
    purpose: 'TUTORING',
    feature: 'wrong_analyze',
    maxTokens: 800,
    messages: [
      { role: 'system', content: SYS },
      {
        role: 'user',
        content: `分析学生这道题做错的原因。

${passage ? `原文片段：\n${String(passage).slice(0, 1200)}\n` : ''}
题干：${stem}
${options?.length ? `选项：${options.join(' | ')}` : ''}
学生答案：${userAnswer || '（未作答）'}
正确答案：${correctAnswer}
考点：${(knowledgePoints || []).join('、') || '未标注'}

只输出这个 JSON，两个字段都用中文，各 80 字以内：
{"errorReason":"错在哪、为什么","memoryPoint":"下次遇到同类题该记住什么"}`,
      },
    ],
  });
  return {
    errorReason: String(data.errorReason || '').slice(0, 300),
    memoryPoint: String(data.memoryPoint || '').slice(0, 300),
  };
}

/** 答案解读：练习即时反馈用，200 字以内 */
export async function explainAnswer(env, { stem, options, userAnswer, correctAnswer, isCorrect, passage }) {
  const { data } = await chatJSON(env, {
    purpose: 'TUTORING',
    feature: 'answer_explain',
    maxTokens: 800,
    messages: [
      { role: 'system', content: SYS },
      {
        role: 'user',
        content: `给学生讲解这道题。

${passage ? `原文片段：\n${String(passage).slice(0, 1200)}\n` : ''}
题干：${stem}
${options?.length ? `选项：${options.join(' | ')}` : ''}
学生答案：${userAnswer || '（未作答）'}
正确答案：${correctAnswer}
学生${isCorrect ? '答对了' : '答错了'}。

只输出这个 JSON，explanation 用中文、200 字以内：
{"explanation":""}`,
      },
    ],
  });
  return String(data.explanation || '').slice(0, 600);
}

/** 能力评估的定性层 */
export async function assessAbility(env, { mastery, recentWrongTags, scoreTrend, totalScore }) {
  const { data } = await chatJSON(env, {
    purpose: 'TUTORING',
    feature: 'assessment',
    messages: [
      { role: 'system', content: SYS },
      {
        role: 'user',
        content: `根据下面这位自考英语考生的数据，给出能力评估。满分 100 分。

各考点掌握情况：
${mastery.map((m) => `${m.name}：做过 ${m.total} 题，正确 ${m.correct} 题，档位 ${m.tier}`).join('\n') || '暂无数据'}

最近错题集中的考点：${recentWrongTags.join('、') || '暂无'}
历次模考总分（由旧到新）：${scoreTrend.join('、') || '暂无'}
统计模型给出的预测分：${totalScore ?? '样本不足'}

只输出这个 JSON：
{"predictedLow":0,"predictedHigh":0,"levelDesc":"一句话水平定位",
 "weakPoints":["考点1","考点2"],"suggestions":["建议1","建议2","建议3"]}`,
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
