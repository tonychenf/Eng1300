// 给上传进来的题生成候选答案（§6.4.10 的"可选的 AI 辅助"）。
//
// **产出一律落 待核，永远不自动发布。** 这是 §6.4.10 的硬约束，也是蓝本
// docs/项目全档.md §9.3 那条教训的直接延伸：AI 返回结构不符时静默给了 0 分，
// 学生看到的是一个理直气壮的错误。答案是判分的基准，错一个答案会让所有做对的
// 学生被判错。
//
// **形状对不上就整道放弃，不写半个答案。** 一道 6 空的填空题，AI 只回了 4 个答案，
// 把前 4 个填进去、后 2 个留空，比整道留空危险得多——前者看起来像"已经录过了"。
import { chatJSON, mapLimit } from './ai.js';
import { INPUT_KINDS } from './question-items.js';

// 与错题分析同一个上限（study.js）。单次 3-4 秒 × 34 道，串行就是两分钟起，
// 而并发开太大会把供应商的速率限制打爆。
export const ANSWER_GEN_CONCURRENCY = 5;

const DEFAULT_SYSTEM =
  '你是一位学科教师。回答一律用简体中文，只输出 JSON，不要任何额外文字。';

/**
 * 答案要落到哪些得分单元上，按 ord 排好。
 * **写回时也用这一个函数**——形状是按它算的，写回按另一套顺序的话，
 * 答案会整体错位一格，而每一空都有值、看起来完全正常。
 */
export function targetItems(question) {
  const items = [...(question.items || [])].sort((a, b) => a.ord - b.ord);
  const inputs = items.filter((it) => INPUT_KINDS.includes(it.kind));
  return inputs.length ? inputs : items;
}

/** 一道题要 AI 回什么形状，取决于它的题型与得分单元。 */
export function shapeOf(question) {
  const items = question.items || [];
  const targets = targetItems(question);
  if (targets.length && items.some((it) => INPUT_KINDS.includes(it.kind))) {
    return { kind: 'BLANKS', count: targets.length };
  }
  if (targets.length) return { kind: 'POINTS', count: targets.length };
  if (question.options && question.options.length) return { kind: 'CHOICE', count: 1 };
  // 既没有单元也没有选项：一句话的简答，要一个整体答案
  return { kind: 'TEXT', count: 1 };
}

function askFor(question, shape) {
  const stem = question.stem || '';
  const opts = (question.options || []).join('\n');
  switch (shape.kind) {
    case 'CHOICE':
      return `下面是一道单项选择题，请给出正确选项。\n题干：${stem}\n选项：\n${opts}\n\n` +
        '只输出 JSON：{"choice":"A"}，choice 必须是上面选项里出现过的那个字母。';
    case 'BLANKS':
      return `下面是一道填空题，题干里的 ＿ 表示要填的空，共 ${shape.count} 个。\n` +
        `题干：${stem}\n\n只输出 JSON：{"blanks":["第1空","第2空",...]}，` +
        `blanks 的长度必须正好是 ${shape.count}，顺序与题干里的空一致。每一项只写答案本身，不要解释。`;
    case 'POINTS':
      return `下面是一道主观题，评分按采分点命中计。\n题干：${stem}\n\n` +
        `只输出 JSON：{"points":["采分点1","采分点2",...]}，共 ${shape.count} 条，` +
        '每条是一句可独立判定命中与否的要点，不要写成一整段话。';
    default:
      return `下面是一道简答题。\n题干：${stem}\n\n只输出 JSON：{"answer":"参考答案"}。`;
  }
}

/** 把 AI 的返回对到题目的形状上。对不上就抛错——由调用方按题记账，不写半个答案。 */
export function shapeAnswer(data, question, shape) {
  const bad = (why) => {
    const e = new Error(`ai_bad_shape: ${question.questionId} ${why}`);
    e.code = 'ai_bad_shape';
    throw e;
  };
  if (shape.kind === 'CHOICE') {
    const v = String(data?.choice ?? '').trim().toUpperCase();
    if (!/^[A-Z]$/.test(v)) bad(`要一个选项字母，收到 ${JSON.stringify(data?.choice)}`);
    // 必须是这道题真有的选项。回一个 E 而题目只有 A-D，是明确的错答，不是"也许对"。
    const labels = (question.options || []).map((o) => String(o).trim().slice(0, 1).toUpperCase());
    if (labels.length && !labels.includes(v)) bad(`回了 ${v}，而这道题的选项是 ${labels.join('/')}`);
    return { answer: v, items: null };
  }
  if (shape.kind === 'BLANKS') {
    const arr = data?.blanks;
    if (!Array.isArray(arr)) bad(`要 blanks 数组，收到 ${typeof arr}`);
    if (arr.length !== shape.count) bad(`要 ${shape.count} 个空，收到 ${arr.length} 个`);
    const vals = arr.map((x) => String(x ?? '').trim());
    if (vals.some((x) => !x)) bad('有空的项');
    return { answer: null, items: vals };
  }
  if (shape.kind === 'POINTS') {
    const arr = data?.points;
    if (!Array.isArray(arr)) bad(`要 points 数组，收到 ${typeof arr}`);
    if (arr.length !== shape.count) bad(`要 ${shape.count} 个采分点，收到 ${arr.length} 个`);
    const vals = arr.map((x) => String(x ?? '').trim());
    if (vals.some((x) => !x)) bad('有空的采分点');
    return { answer: null, items: vals };
  }
  const v = String(data?.answer ?? '').trim();
  if (!v) bad('answer 是空的');
  return { answer: v, items: null };
}

/**
 * 逐题生成候选答案。
 * 返回 { generated, failures }，**不抛错**：题面已经在库里了，
 * 生成不出来的题留在缺答案就好——这次失败没有改变调用方要的那个结果。
 */
export async function generateAnswers(env, { questions, subjectId, prompt }) {
  const failures = [];
  const generated = [];
  await mapLimit(questions, ANSWER_GEN_CONCURRENCY, async (q) => {
    const shape = shapeOf(q);
    try {
      const { data } = await chatJSON(env, {
        purpose: 'PARSING',
        feature: 'answer_generate',
        messages: [
          { role: 'system', content: prompt?.system_prompt || DEFAULT_SYSTEM },
          { role: 'user', content: askFor(q, shape) },
        ],
      });
      generated.push({ questionId: q.questionId, shape: shape.kind, ...shapeAnswer(data, q, shape) });
    } catch (e) {
      failures.push({ questionId: q.questionId, ord: q.ord, reason: e.code || 'ai_failed',
        message: String(e.message || e).slice(0, 200) });
    }
  });
  return { generated, failures };
}
