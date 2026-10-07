// 标准答案自检（2026-10-07）：用真正的判分器把标准答案判一遍，拿不到满分就说清哪一空、为什么。
//
// 为什么要有：第 1 章 q04、q05 的受限选择，题库文件写的是 params.enum、判分器只认 options——
// 题确认了、发布了，学员一交答案就 500，2026-10-04 浏览器实测才照出来。validateItems 早就写好、
// 有单测，却没有任何地方调用。上传的名词解释、问答没有采分点，确认、发布一路畅通，进了卷子
// 每次批改都失败。
//
// **不另立一套"什么算合法"的规则，判据就是判分器本身**：按标准答案作答都拿不到满分的题，
// 学员不可能答对，它就不该被确认、更不该被发布。另立一套的话，两套迟早对不上——
// inputGroupsWithoutAnswer 顶部那段注释说的是同一件事。
//
// 判不了的不判：英语作文（AI 按维度打分）、人工阅卷，没有一份"标准答案"可以喂。
// 采分点式的题造一份"每个采分点都答到了"的 AI 结果喂进去——验的是采分点本身配得对不对
// （有没有、有没有内容、权重、依赖、开放点上限），不是 AI 判得准不准。
import { gradeQuestion } from './grade.js';
import {
  validateItems, inputGroupsWithoutAnswer, toItem, groupItems, INPUT_KINDS, JUDGE_KINDS,
} from './question-items.js';

// 这几种策略没有"标准答案"可喂：维度打分要模型给每个维度打分，人工阅卷要人
const CANNOT_SELF_GRADE = new Set(['AI_DIMENSION', 'AI_LEVEL_BANDED', 'MANUAL']);

/** 判分器抛的错是 "code: 说明"，给管理员看的只要说明 */
const said = (e) => String(e?.message || e).replace(/^[a-z_]+: /, '');

/**
 * 一道题的标准答案能不能用。返回问题清单（给管理员看的话），空数组表示没问题。
 *
 * question 要有 question_id、question_type、answer；itemRows 是 question_items 的行（库里的形状）。
 */
export function answerKeyProblems(pack, question, itemRows, where = '这道题') {
  let type;
  try { type = pack.typeOf(question.question_type); } catch (e) { return [`${where}：${said(e)}`]; }
  const rows = [...(itemRows || [])].sort((a, b) => Number(a.item_ord) - Number(b.item_ord));

  // ① 有没有答案。说法比"只能拿到 0%"直白，也和校对页"确认不了"那句一致
  if (!rows.length) {
    if (type.gradingStrategy === 'AI_SCORE_POINTS') {
      return [`${where}没有采分点：这类题交卷后由 AI 按采分点批改，没有采分点就批不了（在校对页给它加采分点）`];
    }
    if (!type.needsAi && !String(question.answer ?? '').trim()) return [`${where}没有标准答案`];
  }
  const missing = inputGroupsWithoutAnswer(rows, where);
  if (missing.length) return missing;
  const emptyPoints = rows.filter((r) => JUDGE_KINDS.includes(r.item_kind) && !String(r.answer ?? '').trim());
  if (emptyPoints.length) {
    return [`${where}的第 ${emptyPoints.map((r) => r.item_ord).join('、')} 个采分点没有内容，AI 不知道这一点要答什么`];
  }

  // ② 结构（§6.4.9、G8）：序号重复、两类单元混用、组内策略冲突、依赖指错、开放采分点没写上限或说明、
  //    开放点权重超上限。结构都不对时不再往下判——判一遍只会把同一件事换个说法再报一次
  if (rows.length) {
    const cap = pack.rubric?.essay?.openWeightCap;
    const structural = validateItems(rows, {
      ...(cap !== undefined ? { openWeightCap: cap } : {}),
      defaultStrategy: type.gradingStrategy,
      where,
    });
    if (structural.length) return structural;
  }

  // ③ 按标准答案作答，交给判分器判
  let groups = null;
  try {
    if (rows.length) groups = groupItems(rows.map((r) => toItem(r, where)), type.gradingStrategy, where);
  } catch (e) {
    return [`${where}：${said(e)}`];
  }
  const strategies = groups ? groups.map((g) => g.strategy) : [type.gradingStrategy];
  if (strategies.some((s) => CANNOT_SELF_GRADE.has(s))) return [];

  let answer;
  let aiResult;
  if (!groups) {
    answer = String(question.answer ?? '');
  } else if (groups.some((g) => g.items.some((it) => INPUT_KINDS.includes(it.kind)))) {
    const out = {};
    for (const g of groups) {
      const pool = g.items.map((it) => it.params?.pool).find((p) => Array.isArray(p) && p.length);
      if (g.strategy === 'SET' && pool) {
        // 候选池：按池子的顺序填，要几个填几个（"8 个里任填 4 个"就填前 4 个，后面的空着）
        const declared = g.items.map((it) => it.params?.requiredCount).find((v) => v !== undefined);
        const need = declared === undefined ? g.items.length : Number(declared);
        g.items.forEach((it, i) => { out[it.ord] = i < need ? String(pool[i] ?? '') : ''; });
        continue;
      }
      for (const it of g.items) out[it.ord] = it.answer || it.altAnswers[0] || '';
    }
    answer = JSON.stringify(out);
  } else {
    // 整段作答（采分点）：一句非空的话就行，命中与否由下面造的 AI 结果说了算
    answer = '（标准答案自检）';
    aiResult = {
      points: Object.fromEntries(groups.flatMap((g) => g.items).map((it) => [String(it.ord),
        it.params?.openEnded
          ? { count: Number(it.params.maxCount), reason: '自检' }
          : { hit: true, methodOk: true, reason: '自检' }])),
    };
  }

  let g;
  try {
    g = gradeQuestion(pack, question, answer, 100, { items: rows, aiResult });
  } catch (e) {
    return [`${where}：${said(e)}`];
  }
  if (g.pendingAi || g.pendingManual) return [];
  if (g.scoreRate >= 1) return [];
  const missed = (g.itemResults || []).flatMap((r) => (r.items || []).filter((x) => x.hit !== 1).map((x) => x.ord));
  return [`${where}按标准答案作答只能拿到 ${Math.round((g.scoreRate || 0) * 100)}%` +
    (missed.length ? `（第 ${missed.join('、')} 空判不对）` : '') + '，学员不可能答对'];
}
