// 氨基酸命名等价（需求文档 §5.4①）。**按能力注册，不按学科**：
// "氨基酸中英文名等价"对药学、医学、食品科学同样成立，锁进 biochem 目录
// 等于将来复制粘贴（§5.3）。
//
// 折的是 **中文名 ↔ 三字母代号**，外加两处必须显式列出的中文别名。
//
// **单字母代号（A/C/N/…）不在这里折**，虽然 §5.4① 把它列成了第三种写法。
// 理由是这份资料自己给出的：单字母氨基酸代号与元素符号大面积撞车——
// C 既是半胱氨酸又是碳、N 既是天冬酰胺又是氮、S/P/K/V/Y/I/W/F/H 同理。
// 第 1 题问的正是"氮元素"，答案写 N；全局折叠之后 `N` 会变成天冬酰胺，
// 于是"天冬酰胺"也会被判成第 1 题的正确答案——**把错答放过**，
// 正是铁律里排第一的那条。
// 需要认单字母的题，在题目自己的 altAnswers / params.alias 里显式列（现有内容就是这么写的），
// 那是逐题的决定，不是全局规则。
const TABLE = [
  ['甘氨酸', 'gly'],
  ['丙氨酸', 'ala'],
  ['缬氨酸', 'val'],
  ['亮氨酸', 'leu'],
  ['异亮氨酸', 'ile'],
  ['脯氨酸', 'pro'],
  ['苯丙氨酸', 'phe'],
  ['色氨酸', 'trp'],
  ['丝氨酸', 'ser'],
  ['苏氨酸', 'thr'],
  ['半胱氨酸', 'cys'],
  ['酪氨酸', 'tyr'],
  ['天冬酰胺', 'asn'],
  ['谷氨酰胺', 'gln'],
  ['天冬氨酸', 'asp'],
  ['谷氨酸', 'glu'],
  ['赖氨酸', 'lys'],
  ['精氨酸', 'arg'],
  ['组氨酸', 'his'],
  ['蛋氨酸', 'met'],
];

// 中文别名。**必须显式列**，不许用"去掉某个字"这类规则去凑（§5.4①）——
// 规则化的后果是把没列进来的词也折了，而那些词可能是别的物质。
const CN_ALIAS = [
  ['甲硫氨酸', '蛋氨酸'],
  ['门冬氨酸', '天冬氨酸'],
  ['门冬酰胺', '天冬酰胺'],
];

const CANON = new Map();
for (const [cn, three] of TABLE) {
  CANON.set(cn, cn);
  CANON.set(three, cn);
}
for (const [alias, cn] of CN_ALIAS) {
  if (!CANON.has(cn)) throw new Error(`chem-nomenclature: 别名 ${alias} 指向的 ${cn} 不在表里`);
  CANON.set(alias, cn);
}

export function chemNomenclature(raw) {
  const s = String(raw ?? '');
  // 整串正好是一个写法时才折。**不做子串替换**：题干式的长答案里出现 "Ala"
  // 可能是别的意思，而把长句里的片段替换掉会让两段不同的话折成同一段。
  return CANON.get(s) ?? CANON.get(s.toLowerCase()) ?? s;
}

/** 表本身暴露出来，供内容校验与测试用（不要在判分路径上另抄一份）。 */
export const AMINO_ACIDS = TABLE.map(([cn, three]) => ({ cn, three }));
