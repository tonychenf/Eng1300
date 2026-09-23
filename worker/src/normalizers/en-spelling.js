// 英美拼写等价折叠。英语学科的 fill_text 引用它。
//
// 铁律（蓝本 grade.js 传下来的）：归一化器只能做"等价折叠"，不能做"模糊匹配"。
// 宁可判错记错，不可把错答放过——把错答折成对的，学生看到的是一个理直气壮的
// 满分，没人会去查。所以每条规则都要有一个"它不会误判"的反例测试。
//
// 典型反例：通用的"双写 l 还原"会把 filled 折成 filed，那是另一个词。
// 所以这里只列真正成对的词，不做规则化的 ll → l。

// 只列真正成对的词
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

// -our → -or 会把 four 折成 for，这些词不参与该规则
const OUR_KEEP = new Set(['four', 'hour', 'your', 'tour', 'pour', 'sour', 'flour', 'our', 'dour']);

/**
 * 英式拼写统一折向美式。入参已经过骨架的基础折叠（去空白、小写、去首尾标点）。
 * 两边答案都走同一套规则，所以只要不把两个不同的真词折到一起就是安全的。
 */
export function enSpelling(w) {
  if (!w) return w;
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
