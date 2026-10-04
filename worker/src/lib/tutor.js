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
import { toItem, JUDGE_KINDS } from './question-items.js';

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
export function essayRubric(pack) {
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

  return { ...scoreEssayReply(data, R), rubricVersion: pack.rubricVersion };
}

/**
 * 把模型的批改回复读成分数（gradeEssay 调完模型之后的全部处理）。
 * 单独导出，是为了让 test/essay-parse.mjs 测的就是这一份，而不是抄一份去测——
 * 抄来的那份和这里改一处忘一处，测试照样全绿。
 */
export function scoreEssayReply(data, R) {
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
  const comments = data.comments && typeof data.comments === 'object' ? data.comments : {};
  const suggestions = Array.isArray(data.suggestions) ? data.suggestions : [];

  // 模型把提示里的示例原样抄了回来（CR-M11）：示例里的维度分用 0 占位、评语和建议留空，
  // 抄回来就是一个形状完全合法的"0 分"。线上实测 #6 作文拿了 0 分、状态却是"已批改"，
  // 这是可能的原因之一；无论那次是不是，这种回复都不是批改结果。真的给 0 分会说理由——
  // 提示词要了每个维度的评语——所以"分数全 0、评语和建议全空"一律当成没读懂，可重试，
  // 不记成已批改。
  const said = (v) => typeof v === 'string' && v.trim() !== '';
  if (R.keys.every((k) => scores[k] === 0)
      && !Object.values(comments).some(said) && !suggestions.some(said)) {
    throw bad('ai_bad_shape',
      '模型回的维度分全是 0、评语和建议全是空的，像是把提示里的示例原样抄了回来，不是批改结果。' +
      `收到的前 200 字：${JSON.stringify(data).slice(0, 200)}`);
  }

  // 加权那一步走判分器注册表里的 AI_DIMENSION，不在这儿另写一遍：
  // 两份实现改一处忘一处，同一篇作文在两个入口会出两个分，而两边都"成功"。
  const total = Math.round(dimensionRate(R.dims, scores, R.max) * R.full * 10) / 10;

  return { scores, total, comments, suggestions: suggestions.slice(0, 3) };
}

/**
 * 采分点式主观题的提示词材料（名词解释、问答、解答题，§6.6② 类型 B）。
 *
 * 只用 items 里的判定单元（采分点 / 步骤）。权重写成"权重"而不是"分"：
 * 它是相对权重（§6.4.7），这道题在本卷值几分由模板给，写成"2 分"会让模型以为满分是 5 分。
 * "逐个判断学生答案有没有答到"这句由代码生成、不在模板里——替身靠它认出这类调用，
 * 后台把模板改得面目全非也认得出。
 */
export function scorePointsPrompt(rows, where = '题目') {
  const items = rows.map((r) => (r && r.ord !== undefined && r.kind ? r : toItem(r, where)))
    .filter((it) => JUDGE_KINDS.includes(it.kind))
    .sort((a, b) => a.ord - b.ord);
  if (!items.length) {
    throw bad('no_score_points', `${where} 没有采分点（${JUDGE_KINDS.join('/')}），按采分点判不了`);
  }
  const depsOf = (it) => (Array.isArray(it.params?.dependsOn) ? it.params.dependsOn : []);
  const lines = items.map((it) => {
    const tags = [`权重 ${it.weight}`];
    if (it.params?.openEnded) {
      tags.push(`开放：学生答出几条这一类的有效内容就报几条（count），最多计 ${it.params.maxCount} 条`);
    }
    if (depsOf(it).length) {
      tags.push(`建立在第 ${depsOf(it).join('、')} 点之上：另报 methodOk——前面那步错了、这一步方法对，填 true`);
    }
    return `${it.ord}.（${tags.join('；')}）${it.answer}`;
  });
  const shape = '{"points":{' + items.map((it) => {
    if (it.params?.openEnded) return `"${it.ord}":{"count":0,"reason":""}`;
    if (depsOf(it).length) return `"${it.ord}":{"hit":false,"methodOk":false,"reason":""}`;
    return `"${it.ord}":{"hit":false,"reason":""}`;
  }).join(',') + '}}';
  const pointLines =
    `采分点共 ${items.length} 个。逐个判断学生答案有没有答到：意思对就算，不要求原话；答错、答反、只沾到边的不算。\n` +
    lines.join('\n') + '\n' +
    '每个采分点都要给 hit（答到填 true，没答到填 false）和 reason（一句话：答到的指出学生哪句话对应它，' +
    '没答到的说清缺了什么或错在哪里）。';
  return { items, pointLines, jsonShape: shape };
}

const BOOL = new Map([
  ['true', true], ['false', false], ['1', true], ['0', false],
  ['是', true], ['否', false], ['命中', true], ['未命中', false], ['yes', true], ['no', false],
]);
function asBool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number' && (v === 0 || v === 1)) return v === 1;
  if (typeof v === 'string' && BOOL.has(v.trim().toLowerCase())) return BOOL.get(v.trim().toLowerCase());
  return v; // 认不出就原样交给判分器，它会点名"hit 不是布尔值，收到 …"
}

/**
 * 把模型的逐点回复读成判分器要的 { points: { "<序号>": { hit, methodOk?, count?, reason } } }。
 * 单独导出，好让单测测的就是这一份（同 scoreEssayReply）。
 *
 * 读法宽容一点（"true"、1、"是" 都算布尔，键写成"第1点"也认），但读不出来一律抛
 * ai_bad_shape：**没读懂和没答到在成绩单上长得一模一样**（B12），前者绝不能记成 0 分。
 * 缺了哪个采分点、多出哪个，由判分器 AI_SCORE_POINTS 对着题目的采分点核，这里不重复。
 */
export function readScorePointsReply(data) {
  const holders = [data, data?.result, data?.grading, data?.data]
    .filter((o) => o && typeof o === 'object' && !Array.isArray(o));
  const holder = holders.find((o) => o.points !== undefined);
  if (!holder) {
    throw bad('ai_bad_shape',
      `模型返回里没有 points，顶层键为 ${Object.keys(data || {}).join(',') || '（空）'}`);
  }
  const raw = holder.points;
  let entries;
  if (Array.isArray(raw)) {
    // 数组只认带序号的元素。按位置对应的话，模型漏一条又多一条，后面全部错位而不报错。
    entries = raw.map((e, i) => {
      const ord = e && typeof e === 'object' ? (e.ord ?? e.no ?? e.id) : undefined;
      if (ord === undefined) {
        throw bad('ai_bad_shape',
          `points 是数组，第 ${i + 1} 个元素没有序号（ord），对不上是哪个采分点：${JSON.stringify(e).slice(0, 80)}`);
      }
      return [ord, e];
    });
  } else if (raw && typeof raw === 'object') {
    entries = Object.entries(raw);
  } else {
    throw bad('ai_bad_shape', `points 要是对象，收到 ${raw === null ? 'null' : typeof raw}：${String(raw).slice(0, 80)}`);
  }

  const points = {};
  for (const [k, v] of entries) {
    const m = String(k).match(/\d+/);
    const key = m ? String(Number(m[0])) : String(k); // 认不出序号的键原样留着，判分器会点名"多出"
    if (points[key] !== undefined) throw bad('ai_bad_shape', `采分点 ${key} 在回复里出现了两次`);
    if (typeof v === 'boolean' || typeof v === 'string' || typeof v === 'number') {
      points[key] = { hit: asBool(v), reason: '' };
      continue;
    }
    if (!v || typeof v !== 'object') {
      throw bad('ai_bad_shape', `采分点 ${key} 的判定读不出来：${JSON.stringify(v)}`);
    }
    const p = { reason: String(v.reason ?? v.comment ?? '').trim().slice(0, 200) };
    if (v.hit !== undefined) p.hit = asBool(v.hit);
    if (v.methodOk !== undefined) p.methodOk = asBool(v.methodOk);
    if (v.count !== undefined) {
      const n = Number(v.count);
      p.count = Number.isInteger(n) ? n : v.count;
    }
    points[key] = p;
  }

  // 照抄示例（同 CR-M11）：示例里每个采分点都是 hit:false、count:0、理由留空，原样抄回来
  // 是一个形状完全合法的"0 分"。真的一点没答到，提示词要了逐点理由，总会说缺了什么。
  const vals = Object.values(points);
  if (vals.length && vals.every((p) => p.hit !== true && !(p.count > 0) && !p.reason)) {
    throw bad('ai_bad_shape',
      '模型回的采分点全是没答到、理由全是空的，像是把提示里的示例原样抄了回来，不是批改结果。' +
      `收到的前 200 字：${JSON.stringify(data).slice(0, 200)}`);
  }
  return { points };
}

/**
 * 采分点式主观题批改：调模型逐点判命中，返回判分器要的 aiResult。
 * **分不在这里算**——命中率怎么折成分、给不给部分分，走 lib/grade.js 那唯一的判分循环。
 */
export async function gradeScorePoints(env, pack, { stem, assets, answer, items, where }) {
  const r = pack.rubric.essay;
  if (r?.type !== 'POINT_HIT') {
    // 反过来同 essayRubric：维度加权的学科走不到这里，走到了就是题型和评价标准配岔了
    throw bad('rubric_not_implemented',
      `学科 ${pack.code} 的主观题评分标准是 ${r?.type}，按采分点批改要求 POINT_HIT`);
  }
  const { pointLines, jsonShape } = scorePointsPrompt(items, where);
  const stemText = stemForAi(stem, assets);
  const { systemPrompt, userTemplate } = await prompts(env, pack, 'essay_grade');
  const { data } = await chatJSON(env, {
    purpose: 'TUTORING',
    feature: 'essay_grade',
    maxTokens: 1200,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        // 新旧两套变量名都给：0017 把生化模板换成了 {{stem}} {{answer}} {{pointLines}}，
        // 后台改过、还用着旧名字（{{prompt}} {{essay}} {{dimensionLines}}）的照样渲染得出来。
        content: renderTemplate(userTemplate, {
          subjectName: pack.name,
          stem: stemText,
          answer,
          pointLines,
          prompt: stemText,
          essay: answer,
          dimensionLines: pointLines,
          jsonShape,
        }),
      },
    ],
  });
  return readScorePointsReply(data);
}

/** 把模型给的逐点理由并进判分结果，报告里"逐点判定"每一行后面显示。 */
export function withPointReasons(itemResults, points) {
  if (!Array.isArray(itemResults)) return itemResults;
  return itemResults.map((g) => ({
    ...g,
    items: (g.items || []).map((it) => {
      const reason = points?.[String(it.ord)]?.reason;
      return reason ? { ...it, reason } : it;
    }),
  }));
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
