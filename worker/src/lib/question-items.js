// 得分单元（question_items）的读取、归组与校验（需求文档 §6.4.5）。
//
// 一题多空的"空"、主观题的"采分点"、多选的"选项"、解答题的"步骤"是同一个概念：
// **题目的一个子项，自带权重，自带一次命中判定**。所以只有一张表、一段循环。
import { resolveGrader, fail } from '../graders/index.js';

export const ITEM_KINDS = ['BLANK', 'SCORE_POINT', 'OPTION', 'STEP'];

// 四种单元分两类，差别在**学生的答案怎么落到单元上**：
//   输入单元（BLANK / OPTION）：学生逐个填，作答是 {"序号":"答案"} 的 JSON
//   判定单元（SCORE_POINT / STEP）：学生写一整段，判分时才拆成采分点
// 这个区分不是又一个枚举分支——判分循环对两类一视同仁，只有拆答案这一步要分开。
export const INPUT_KINDS = ['BLANK', 'OPTION'];
export const JUDGE_KINDS = ['SCORE_POINT', 'STEP'];

/** 只吃库里那一行的形状（snake_case）。测试也构造同一种形状，免得测的是另一条路。 */
export function toItem(row, where) {
  const ord = Number(row?.item_ord);
  if (!Number.isInteger(ord) || ord <= 0) {
    throw fail('bad_item', `${where} 的得分单元缺少 item_ord（读到 ${JSON.stringify(row?.item_ord)}）`);
  }
  const kind = String(row.item_kind || '');
  if (!ITEM_KINDS.includes(kind)) {
    throw fail('bad_item', `${where} #${ord} 的 item_kind 是 ${JSON.stringify(row.item_kind)}，只认 ${ITEM_KINDS.join('、')}`);
  }
  const weight = row.weight === undefined || row.weight === null ? 1 : Number(row.weight);
  if (!Number.isFinite(weight) || weight <= 0) {
    throw fail('bad_item_weight', `${where} #${ord} 的权重是 ${JSON.stringify(row.weight)}，要求正数`);
  }
  return {
    ord,
    kind,
    strategy: row.grading_strategy ? String(row.grading_strategy) : null,
    groupKey: row.group_key === undefined || row.group_key === null || row.group_key === ''
      ? null : String(row.group_key),
    answer: row.answer == null ? '' : String(row.answer),
    altAnswers: parseJsonArray(row.alt_answers, `${where} #${ord} 的 alt_answers`),
    weight,
    params: parseJsonObject(row.params, `${where} #${ord} 的 params`),
    given: '',
  };
}

function parseJsonArray(raw, where) {
  if (raw === undefined || raw === null || raw === '') return [];
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  let v;
  try { v = JSON.parse(raw); } catch {
    throw fail('bad_item_json', `${where} 不是合法 JSON：${String(raw).slice(0, 60)}`);
  }
  if (!Array.isArray(v)) throw fail('bad_item_json', `${where} 不是数组，是 ${typeof v}`);
  return v.map((x) => String(x));
}

function parseJsonObject(raw, where) {
  if (raw === undefined || raw === null || raw === '') return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  let v;
  try { v = JSON.parse(raw); } catch {
    throw fail('bad_item_json', `${where} 不是合法 JSON：${String(raw).slice(0, 60)}`);
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw fail('bad_item_json', `${where} 不是对象，是 ${Array.isArray(v) ? '数组' : typeof v}`);
  }
  return v;
}

/**
 * 按 group_key 归组，没有 group_key 的自成一组（§6.4.5 的判分伪码）。
 *
 * 组的顺序按组内最小 ord，不按 group_key 的字母序——报告里"第一空、第二空"要和
 * 题面对得上。同组单元的策略必须一致：不一致时抛错，不挑一个用。
 */
export function groupItems(items, defaultStrategy, where) {
  const byKey = new Map();
  for (const it of items) {
    const key = it.groupKey === null ? `#${it.ord}` : `g:${it.groupKey}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(it);
  }
  const groups = [...byKey.entries()].map(([key, list]) => {
    const sorted = [...list].sort((a, b) => a.ord - b.ord);
    const declared = [...new Set(sorted.map((i) => i.strategy).filter(Boolean))];
    if (declared.length > 1) {
      throw fail('group_strategy_conflict',
        `${where} 的单元组 ${key} 里声明了 ${declared.join('、')} 两种以上判分策略，判不了`);
    }
    const strategy = declared[0] || defaultStrategy;
    if (!strategy) {
      throw fail('strategy_missing',
        `${where} 的单元组 ${key} 既没写 grading_strategy，题型也没声明默认策略`);
    }
    return {
      key,
      strategy,
      grader: resolveGrader(strategy, `${where} 的单元组 ${key}`),
      items: sorted,
      weight: sorted.reduce((a, i) => a + i.weight, 0),
      minOrd: sorted[0].ord,
    };
  });
  groups.sort((a, b) => a.minOrd - b.minOrd);
  return groups;
}

/**
 * 把学生的作答拆到各个得分单元上。
 *
 * 多单元题的作答是一个 JSON 对象，键是单元序号：{"1":"天冬氨酸","2":"谷氨酸"}。
 * 用序号而不是数组下标，是因为题目改版加删空之后，下标会整体错位而不报错。
 *
 * 读不出来一律抛错，不按"整串当成第一个空"处理——那会让学生的答案静默丢掉大半，
 * 判出来的分还挺像回事。
 */
export function parseItemAnswers(raw, items, where) {
  const map = new Map(items.map((i) => [i.ord, '']));
  const text = raw == null ? '' : String(raw);

  const inputs = items.filter((i) => INPUT_KINDS.includes(i.kind));
  if (inputs.length && inputs.length !== items.length) {
    // 一道题要么逐空填、要么整段答。混在一起时"整段"从哪里到哪里没人说得清，
    // 而猜错的后果是采分点拿到半截作答，AI 照样给出一个像样的分数。
    throw fail('mixed_item_kinds',
      `${where} 同时有输入单元（${inputs.map((i) => i.ord).join('、')}）和判定单元` +
      `（${items.filter((i) => !INPUT_KINDS.includes(i.kind)).map((i) => i.ord).join('、')}）：` +
      '拆不出每个单元对应哪一段作答，拆成两道题，或者全部改成同一类');
  }
  // 整段答的题（名词解释、问答、解答题）：每个判定单元拿到的都是整段原文，
  // 判命中是 AI 的事，不是在这里按序号切出来的。
  if (!inputs.length) {
    for (const it of items) map.set(it.ord, text);
    return map;
  }
  if (!text.trim()) return map;

  if (items.length === 1) {
    // 单单元退化：整串就是这个单元的答案。只有当它**恰好**是一个键为本单元序号的
    // JSON 对象时才按多单元格式解——否则学生在填空里打一对大括号就会把判分弄崩。
    const one = tryJsonObject(text);
    const keys = one ? Object.keys(one) : [];
    if (one && keys.length === 1 && Number(keys[0]) === items[0].ord) {
      map.set(items[0].ord, one[keys[0]] == null ? '' : String(one[keys[0]]));
    } else {
      map.set(items[0].ord, text);
    }
    return map;
  }

  let obj;
  try { obj = JSON.parse(text); } catch {
    throw fail('item_answer_unreadable',
      `${where} 有 ${items.length} 个得分单元，作答应当是 {"序号":"答案"} 的 JSON，` +
      `收到的不是合法 JSON：${text.slice(0, 40)}`);
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw fail('item_answer_unreadable',
      `${where} 的作答要是对象，收到 ${Array.isArray(obj) ? '数组' : typeof obj}：${text.slice(0, 40)}`);
  }
  for (const [k, v] of Object.entries(obj)) {
    const ord = Number(k);
    if (!map.has(ord)) {
      // 键对不上说明前端与题库版本不一致，静默忽略就是把学生写的东西扔掉
      throw fail('item_answer_unknown_ord',
        `${where} 的作答里有单元 ${JSON.stringify(k)}，题目的单元是 ${[...map.keys()].join('、')}`);
    }
    map.set(ord, v == null ? '' : String(v));
  }
  return map;
}

function tryJsonObject(text) {
  const t = text.trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch { return null; }
}

/** 一次读多道题的得分单元，返回 questionId → 行数组（原样，未 toItem）。 */
export async function loadItemRows(db, questionIds) {
  const ids = [...new Set(questionIds.filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  // D1 的变量上限是 100，分批读
  for (let i = 0; i < ids.length; i += 90) {
    const batch = ids.slice(i, i + 90);
    const { results } = await db.prepare(
      `SELECT * FROM question_items WHERE question_id IN (${batch.map(() => '?').join(',')})
        ORDER BY question_id, item_ord`
    ).bind(...batch).all();
    for (const r of results) {
      if (!out.has(r.question_id)) out.set(r.question_id, []);
      out.get(r.question_id).push(r);
    }
  }
  return out;
}

/**
 * 题目契约里与得分单元有关的那几条（§6.4.9、G8）。**在种子生成阶段调用**，
 * 返回问题清单；空数组表示这道题的单元没问题。
 *
 * 为什么不在判分时查：判分时才发现"开放采分点占了 80% 的权重"已经晚了，
 * 那时学生正在等分数，而唯一的选择是判错或者放过。
 */
export function validateItems(rows, { openWeightCap = 0.3, defaultStrategy = null, where = '题目' } = {}) {
  const problems = [];
  let items;
  try {
    items = rows.map((r) => toItem(r, where));
  } catch (e) {
    return [e.message];
  }
  const ords = items.map((i) => i.ord);
  if (new Set(ords).size !== ords.length) problems.push(`${where} 的 item_ord 有重复：${ords.join('、')}`);
  const inputCount = items.filter((i) => INPUT_KINDS.includes(i.kind)).length;
  if (inputCount && inputCount !== items.length) {
    problems.push(`${where} 同时有输入单元（${INPUT_KINDS.join('/')}）和判定单元（${JUDGE_KINDS.join('/')}），` +
      '拆不出每个单元对应哪一段作答');
  }

  let groups = null;
  try {
    groups = groupItems(items, defaultStrategy, where);
  } catch (e) {
    problems.push(e.message);
  }

  for (const g of groups || []) {
    for (const it of g.items) {
      const deps = Array.isArray(it.params?.dependsOn) ? it.params.dependsOn : [];
      for (const d of deps) {
        if (!g.items.some((x) => x.ord === d) || d >= it.ord) {
          problems.push(`${where} #${it.ord} 依赖 #${d}，但它不在同一个单元组里或序号不在前面`);
        }
      }
      if (it.params?.openEnded) {
        if (it.kind !== 'SCORE_POINT' && it.kind !== 'STEP') {
          // 客观题的空开放化等于没有标准答案，那不叫判分
          problems.push(`${where} #${it.ord} 是 ${it.kind}，不能设成开放采分点`);
        }
        if (!Number.isInteger(Number(it.params.maxCount)) || Number(it.params.maxCount) <= 0) {
          problems.push(`${where} #${it.ord} 是开放采分点，maxCount 要是正整数（读到 ${JSON.stringify(it.params.maxCount)}）`);
        }
        if (!String(it.params.guide || '').trim()) {
          problems.push(`${where} #${it.ord} 是开放采分点，必须写 guide 说明什么样的论点算数`);
        }
      }
    }
  }

  // G8：开放采分点的权重占比上限。超了就不是"采分点式判分"了，而是 AI 凭印象打分，
  // 失去了它唯一的好处——可核对。
  const totalW = items.reduce((a, i) => a + i.weight, 0);
  const openW = items.filter((i) => i.params?.openEnded).reduce((a, i) => a + i.weight, 0);
  if (totalW > 0 && openW / totalW > Number(openWeightCap) + 1e-9) {
    problems.push(
      `${where} 的开放采分点占了 ${(openW / totalW * 100).toFixed(0)}% 的权重，` +
      `上限是 ${(Number(openWeightCap) * 100).toFixed(0)}%（rubric.essay.openWeightCap）`);
  }
  return problems;
}
