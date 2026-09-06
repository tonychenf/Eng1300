// 客观题判分。依据 docs/prd.md §4.3。
//
// 选择题精确匹配选项字母；完形填空按官方评分参考"语法或拼写错误均不给分、
// 英美拼写均可接受、大小写不扣分"，且只有满分或零分，没有部分分。
//
// PRD §4.3 第4步的"AI 二次判定"留到 M5：这一期规则判不对的一律记错，
// 并标记 needsAiReview，报告里注明该题未经 AI 复核。

// 英美拼写对照：只列真正成对的词。不敢用通用的"双写 l 还原"规则——
// filled 会被还原成 filed，那是另一个词，会把错答判成对。
const SPELLING_PAIRS = [
  ['travelled', 'traveled'], ['travelling', 'traveling'], ['traveller', 'traveler'],
  ['cancelled', 'canceled'], ['cancelling', 'canceling'],
  ['labelled', 'labeled'], ['labelling', 'labeling'],
  ['modelled', 'modeled'], ['modelling', 'modeling'],
  ['signalled', 'signaled'], ['signalling', 'signaling'],
  ['marvellous', 'marvelous'], ['skilful', 'skillful'], ['fulfil', 'fulfill'],
  ['practise', 'practice'], ['licence', 'license'], ['defence', 'defense'],
  ['offence', 'offense'], ['pretence', 'pretense'],
  ['grey', 'gray'], ['programme', 'program'], ['storey', 'story'],
  ['judgement', 'judgment'], ['ageing', 'aging'], ['enrolment', 'enrollment'],
  ['instalment', 'installment'], ['fulfilment', 'fulfillment'],
  ['analyse', 'analyze'], ['paralyse', 'paralyze'],
];
const PAIR_MAP = new Map();
for (const [uk, us] of SPELLING_PAIRS) PAIR_MAP.set(uk, us);

// -our → -or 会把 four 变成 for，这些词不参与该规则
const OUR_KEEP = new Set(['four', 'hour', 'your', 'tour', 'pour', 'sour', 'flour', 'our', 'dour']);

/**
 * 把一个词化成规范形式：英式拼写统一折向美式。
 * 两边都走同一套规则，所以只要不把两个不同的真词折到一起就是安全的。
 */
export function canonWord(raw) {
  let w = String(raw ?? '').trim().toLowerCase();
  if (!w) return '';
  // 去掉首尾标点，中间的连字符、撇号保留
  w = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (PAIR_MAP.has(w)) return PAIR_MAP.get(w);

  // -ise/-isation 家族：只有当英式与美式确为一对时才会撞上，正是想要的效果
  w = w.replace(/isation$/, 'ization')
       .replace(/isations$/, 'izations')
       .replace(/ising$/, 'izing')
       .replace(/ised$/, 'ized')
       .replace(/iser$/, 'izer')
       .replace(/isers$/, 'izers')
       .replace(/ise$/, 'ize')
       .replace(/ises$/, 'izes');

  if (!OUR_KEEP.has(w)) w = w.replace(/our$/, 'or').replace(/ours$/, 'ors');
  w = w.replace(/tre$/, 'ter').replace(/tres$/, 'ters');
  return w;
}

/** 选项字母：去空白、去标点、转大写 */
export function canonChoice(raw) {
  return String(raw ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
}

/**
 * 判一道题。
 * 返回 { isCorrect, score, needsAiReview }；作文返回 isCorrect=null 表示待 AI 批改。
 */
export function gradeQuestion(question, userAnswer, scorePerQuestion) {
  const type = question.question_type;

  if (type === 'essay') {
    return { isCorrect: null, score: null, needsAiReview: true };
  }

  const answered = String(userAnswer ?? '').trim();
  if (!answered) return { isCorrect: 0, score: 0, needsAiReview: false };

  if (type === 'single_choice') {
    const ok = canonChoice(answered) === canonChoice(question.answer);
    return { isCorrect: ok ? 1 : 0, score: ok ? scorePerQuestion : 0, needsAiReview: false };
  }

  // fill_blank_transform：完全一致或英美拼写等价才给分，不给部分分
  const ok = canonWord(answered) === canonWord(question.answer);
  return {
    isCorrect: ok ? 1 : 0,
    score: ok ? scorePerQuestion : 0,
    // 规则判错的交给 AI 复核（M5），判对的没必要再问
    needsAiReview: !ok,
  };
}
