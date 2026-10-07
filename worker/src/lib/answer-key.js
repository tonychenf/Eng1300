// 标准答案与学员作答的"人话"版本（2026-10-07）。
//
// 多空题的答案逐空存在 question_items 里，questions.answer 是空的。以前错题本、AI 错题分析都只看
// questions.answer：生化填空进了错题本，「正确答案」一栏是空的，「你的答案」是一串 {"1":"碳"} 代码；
// AI 错题分析拿到的正确答案也是空的——模型只能自己猜答案再写分析，不报错，但可能讲错。
// "任填几个"的空（SET 候选池）各空都没有自己的答案，报告和练习里答错了也看不到可接受的答案。
//
// 这里是唯一一处把这些拼成人话的地方：错题本、报告、练习、喂给 AI 的提示词都从这里取，
// 不各拼各的。归组规则照抄 question-items.js 的 groupItems（group_key 为空自成一组、
// 组的策略取组内声明的那个，没声明用题型的默认策略）——显示的分组和判分的分组必须是同一套，
// 否则会出现"判分按无序算对了、页面却按位置标出另一个正确答案"。
import { INPUT_KINDS, JUDGE_KINDS } from './question-items.js';

function parseJson(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return fallback; }
}

const str = (v) => (v === undefined || v === null ? '' : String(v).trim());

/** 第 1–6 空 / 第 1、3 空 / 第 2 空。连续的写成区间，不连续的逐个列。 */
export function ordLabel(ords, unit = '空') {
  const s = [...ords].sort((a, b) => a - b);
  const contiguous = s.every((v, i) => i === 0 || v === s[i - 1] + 1);
  if (s.length > 2 && contiguous) return `第 ${s[0]}–${s[s.length - 1]} ${unit}`;
  return `第 ${s.join('、')} ${unit}`;
}

/**
 * 一道题的标准答案，返回 { text, groups }。
 *
 * groups 按组内最小序号排，每组一种形状：
 *   EACH       各空各自的答案（EXACT / ENUM / NUMERIC……）：一空一组
 *   UNORDERED  无序并列的空（SET、没写候选池）：几个答案、顺序不限
 *   POOL       候选池（SET 带 params.pool）："从这 8 个里任填 4 个"
 *   POINTS     采分点（名词解释、问答……整段作答、按点判）
 * text 是整道题一行的写法，给错题本和 AI 提示词用；没有得分单元的题就是 questions.answer 原文。
 *
 * 没录答案的空写"（未录入）"，不省略——省略了，"第 3 空没有答案"就看不出来了。
 */
export function answerKey(question, itemRows, { defaultStrategy = null } = {}) {
  const rows = [...(itemRows || [])].sort((a, b) => Number(a.item_ord) - Number(b.item_ord));
  if (!rows.length) return { text: str(question?.answer), groups: [] };

  const inputs = rows.filter((r) => INPUT_KINDS.includes(r.item_kind));
  const judges = rows.filter((r) => JUDGE_KINDS.includes(r.item_kind));
  const groups = [];

  const byKey = new Map();
  for (const r of inputs) {
    const key = r.group_key === undefined || r.group_key === null || r.group_key === ''
      ? `#${r.item_ord}` : `g:${r.group_key}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }
  for (const list of byKey.values()) {
    const ords = list.map((r) => Number(r.item_ord));
    const declared = list.map((r) => r.grading_strategy).find(Boolean);
    const strategy = declared || defaultStrategy;
    const params = list.map((r) => parseJson(r.params, {}) || {});
    const pool = params.map((p) => p.pool).find((p) => Array.isArray(p) && p.length);
    if (pool) {
      const declaredCount = params.map((p) => p.requiredCount).find((v) => v !== undefined);
      const required = Number.isInteger(Number(declaredCount)) && Number(declaredCount) > 0
        ? Number(declaredCount) : ords.length;
      groups.push({ kind: 'POOL', ords, values: pool.map(str), required });
    } else if (strategy === 'SET' && list.length > 1) {
      groups.push({ kind: 'UNORDERED', ords, values: list.map((r) => str(r.answer)) });
    } else {
      for (const r of list) groups.push({ kind: 'EACH', ords: [Number(r.item_ord)], values: [str(r.answer)] });
    }
  }
  groups.sort((a, b) => Math.min(...a.ords) - Math.min(...b.ords));
  if (judges.length) {
    groups.push({ kind: 'POINTS', ords: judges.map((r) => Number(r.item_ord)), values: judges.map((r) => str(r.answer)) });
  }

  for (const g of groups) {
    const shown = g.values.map((v) => v || '（未录入）');
    if (g.kind === 'POINTS') {
      g.label = '采分点';
      g.note = '';
      g.text = `采分点：${shown.map((v, i) => `${i + 1}）${v}`).join('；')}`;
      continue;
    }
    g.label = ordLabel(g.ords);
    if (g.kind === 'POOL') {
      g.note = g.required < g.values.length
        ? `任填 ${g.required} 个${g.required > 1 ? '，顺序不限' : ''}`
        : (g.values.length > 1 ? '顺序不限' : '');
    } else {
      g.note = g.kind === 'UNORDERED' ? '顺序不限' : '';
    }
    g.text = `${g.label}${g.note ? `（${g.note}）` : ''}：${shown.join('、')}`;
  }

  // 只有一个空、各自作答的题（上传的单空填空），答案就是那个词，不必写"第 1 空："
  const text = groups.length === 1 && groups[0].kind === 'EACH' && !judges.length
    ? (groups[0].values[0] || '（未录入）')
    : groups.map((g) => g.text).join('；');
  return { text, groups };
}

/** 判分结果里某个单元对没对（item_results 的形状见 grade.js）；没判过返回 null。 */
function hitOf(itemResults, ord) {
  for (const g of itemResults || []) {
    const it = (g.items || []).find((x) => Number(x.ord) === Number(ord));
    if (it) return it.hit === 1;
  }
  return null;
}

/**
 * 学员作答的人话版本。多空题的作答存的是 {"序号":"答案"}，直接显示就是一串代码。
 * 带上判分结果（item_results）时逐空标出对错——给 AI 的错题分析用：告诉它错的是哪一空，
 * 省得它自己重判一遍（它不认得"C"就是"碳"那条别名，会把对的说成错的）。
 *
 * 这只是显示：读不懂的作答原样返回，不抛错（判分那条路读不懂会抛，那是另一回事）。
 */
export function answerText(raw, itemRows, itemResults = null) {
  const text = raw === undefined || raw === null ? '' : String(raw);
  const inputs = [...(itemRows || [])].filter((r) => INPUT_KINDS.includes(r.item_kind))
    .sort((a, b) => Number(a.item_ord) - Number(b.item_ord));
  if (!inputs.length) return text;
  const results = typeof itemResults === 'string' ? parseJson(itemResults, null) : itemResults;
  const mark = (ord) => {
    const h = hitOf(results, ord);
    return h === null ? '' : (h ? '（对）' : '（错）');
  };
  const t = text.trim();
  const obj = t.startsWith('{') ? parseJson(t, null) : null;
  const isObj = obj && typeof obj === 'object' && !Array.isArray(obj);
  // 没填的空只写"（未填）"，不再跟一个"（错）"
  const shown = (v, ord) => (v ? `${v}${mark(ord)}` : '（未填）');
  if (inputs.length === 1) {
    const ord = Number(inputs[0].item_ord);
    const keys = isObj ? Object.keys(obj) : [];
    const v = isObj && keys.length === 1 && Number(keys[0]) === ord ? str(obj[keys[0]]) : t;
    return shown(v, ord);
  }
  if (!isObj) return text;
  return inputs.map((r) => {
    const ord = Number(r.item_ord);
    return `第 ${ord} 空：${shown(str(obj[ord]), ord)}`;
  }).join('；');
}
