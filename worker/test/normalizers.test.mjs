// 归一化器单测。两件事：
//   1. 拆分之后英语判分**一个字符都不能变**（验收 A1/A4：英语行为零漂移）。
//      做法是把蓝本原来的 canonWord / canonChoice 原样冻在这个文件里当参照物，
//      拿它去对新的"基础折叠 + 声明的归一化器"链。两边不同源，才对得出东西。
//   2. 每条等价规则都要有**非等价**用例。等价用例只能说明规则生效了，
//      说明不了它没把别的词也折进来——而那正是"把错答判成对"的来源。
import { baseFold } from '../src/lib/grade.js';
import { enSpelling } from '../src/normalizers/en-spelling.js';
import { choice } from '../src/normalizers/choice.js';
import { NORMALIZERS, resolveNormalizers } from '../src/normalizers/index.js';
import { cjkWidth } from '../src/normalizers/cjk-width.js';
import { chemNomenclature } from '../src/normalizers/chem-nomenclature.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};

// ───────── 蓝本原实现，原样冻结，不要"顺手同步" ─────────
// 它存在的唯一意义就是和新实现不同源。跟着新实现一起改的话，这组对比就成了恒等式。
const SPELLING_PAIRS = [
  ['travelled','traveled'],['travelling','traveling'],['traveller','traveler'],
  ['cancelled','canceled'],['cancelling','canceling'],
  ['labelled','labeled'],['labelling','labeling'],
  ['modelled','modeled'],['modelling','modeling'],
  ['signalled','signaled'],['signalling','signaling'],
  ['marvellous','marvelous'],['skilful','skillful'],['fulfil','fulfill'],
  ['practise','practice'],['licence','license'],['defence','defense'],
  ['offence','offense'],['pretence','pretense'],
  ['grey','gray'],['programme','program'],['storey','story'],
  ['judgement','judgment'],['ageing','aging'],['enrolment','enrollment'],
  ['instalment','installment'],['fulfilment','fulfillment'],
  ['analyse','analyze'],['paralyse','paralyze'],
];
const LEGACY_PAIR = new Map(SPELLING_PAIRS);
const LEGACY_OUR_KEEP = new Set(['four','hour','your','tour','pour','sour','flour','our','dour']);
function legacyCanonWord(raw) {
  let w = String(raw ?? '').trim().toLowerCase();
  if (!w) return '';
  w = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (LEGACY_PAIR.has(w)) return LEGACY_PAIR.get(w);
  w = w.replace(/isation$/,'ization').replace(/isations$/,'izations')
       .replace(/ising$/,'izing').replace(/ised$/,'ized')
       .replace(/iser$/,'izer').replace(/isers$/,'izers')
       .replace(/ise$/,'ize').replace(/ises$/,'izes');
  if (!LEGACY_OUR_KEEP.has(w)) w = w.replace(/our$/,'or').replace(/ours$/,'ors');
  w = w.replace(/tre$/,'ter').replace(/tres$/,'ters');
  return w;
}
function legacyCanonChoice(raw) {
  return String(raw ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
}

// ───────── 新实现：英语两个题型各自的链 ─────────
const GRADING = { caseSensitive: false };            // 英语 rubric 里的值
const newWord   = (s) => enSpelling(baseFold(s, GRADING));
const newChoice = (s) => choice(baseFold(s, GRADING));

console.log('== 英语判分零漂移：新链与蓝本原实现逐项对比 ==');
const wordCorpus = [
  ...SPELLING_PAIRS.flat(),
  ...LEGACY_OUR_KEEP,
  'organisation','organisations','organising','organised','organiser','organisers',
  'realise','realises','recognise','apologise',
  'colour','colours','favour','behaviour','neighbours',
  'centre','centres','theatre','metre','litre',
  'filled','filed','quickly','QUICKLY',' Quickly ','quickly.','"quickly"','(quickly)',
  'well-known',"don't",'up-to-date','', '   ', '...', '123', 'a1',
  null, undefined, 42,
];
let drift = 0;
for (const s of wordCorpus) {
  if (newWord(s) !== legacyCanonWord(s)) {
    drift++;
    console.log(`  FAIL 词语折叠漂移：${JSON.stringify(s)} 蓝本=${JSON.stringify(legacyCanonWord(s))} 现在=${JSON.stringify(newWord(s))}`);
  }
}
check(`${wordCorpus.length} 个词的折叠结果与蓝本完全一致`, drift, 0);

const choiceCorpus = ['A','a','b.','(C)','D、','  e  ','答案是A','AB','','A1', null, undefined];
let cdrift = 0;
for (const s of choiceCorpus) {
  if (newChoice(s) !== legacyCanonChoice(s)) {
    cdrift++;
    console.log(`  FAIL 选项折叠漂移：${JSON.stringify(s)} 蓝本=${JSON.stringify(legacyCanonChoice(s))} 现在=${JSON.stringify(newChoice(s))}`);
  }
}
check(`${choiceCorpus.length} 个选项的折叠结果与蓝本完全一致`, cdrift, 0);

console.log('== 等价：该折到一起的确实折到一起了 ==');
check('travelled = traveled',   newWord('travelled') === newWord('traveled'), true);
check('organise = organize',    newWord('organise') === newWord('organize'), true);
check('colour = color',         newWord('colour') === newWord('color'), true);
check('centre = center',        newWord('centre') === newWord('center'), true);
check('大小写不影响',           newWord('Quickly') === newWord('quickly'), true);
check('首尾标点不影响',         newWord('"quickly".') === newWord('quickly'), true);

console.log('== 非等价：不该折到一起的没有被放过 ==');
// 这一组才是重点。等价规则写宽一格，错答就会被判成对，而学生看到的是一个
// 理直气壮的满分，没有任何地方会报错。
check('filled 不等于 filed（不做通用的双写 l 还原）', newWord('filled') === newWord('filed'), false);
check('four 不等于 for（-our 规则的例外表）',          newWord('four') === newWord('for'), false);
check('hour 不等于 hor',                              newWord('hour') === newWord('hor'), false);
check('flour 不等于 flor',                            newWord('flour') === newWord('flor'), false);
// -ise → -ize 是条机械规则，wise 也会被折成 wize。这不是缺陷：两边答案走同一套
// 规则，而 wize 不是个词，撞不上任何别的真词。规则真正要守住的性质是
// **不把两个不同的真词折到一起**，所以断言写成这个。
check('wise 不等于 wide',                              newWord('wise') === newWord('wide'), false);
check('rise 不等于 rice',                              newWord('rise') === newWord('rice'), false);
check('precise 不等于 precis',                         newWord('precise') === newWord('precis'), false);
check('quickly 不等于 quick',                          newWord('quickly') === newWord('quick'), false);
check('中间的连字符保留，well-known 不等于 wellknown',  newWord('well-known') === newWord('wellknown'), false);
check("撇号保留，don't 不等于 dont",                    newWord("don't") === newWord('dont'), false);
check('AB 不等于 A（不把首字母当答案）',                newChoice('AB') === newChoice('A'), false);

console.log('== 未知归一化器要当场抛错 ==');
// 静默跳过的后果是判分悄悄变严（少折一层等价），表现为"某些对的答案被判错"，
// 而没有任何地方会报错。
let code = null;
try { resolveNormalizers(['no-such-normalizer'], '测试'); } catch (e) { code = e.code; }
check('认不出的名字抛 unknown_normalizer', code, 'unknown_normalizer');
let msg = '';
try { resolveNormalizers(['no-such-normalizer'], '测试用的题型'); } catch (e) { msg = e.message; }
check('报错里说清楚是谁声明的', msg.includes('测试用的题型'), true);
check('报错里列出注册表有哪些', msg.includes('en-spelling'), true);
check('空数组是合法的（表示不需要任何学科专属等价）', resolveNormalizers([], 'x').length, 0);
// 原来这条是把注册表的全部键名写死比对。那测的是"有没有人加过归一化器"，
// 每加一个能力就红一次，而红了之后正确的做法永远是改期望值——这种断言不提供信号。
// 真正要守住的性质是 §5.3 的那一条：**按能力注册，不按学科**。
const subjectish = Object.keys(NORMALIZERS)
  .filter((k) => /english|biochem|英语|生化|chinese|math/i.test(k));
check('注册表里没有以学科命名的归一化器', subjectish.join(','), '');
check('注册表的值全是函数',
  Object.values(NORMALIZERS).every((f) => typeof f === 'function'), true);
check('键名全是小写连字符（能被 JSON 声明直接引用）',
  Object.keys(NORMALIZERS).every((k) => /^[a-z][a-z0-9-]*$/.test(k)), true);

console.log('== 生化：全角/希腊字母与氨基酸命名（§5.4） ==');
const cw = (x) => cjkWidth(baseFold(x));
const cn = (x) => chemNomenclature(baseFold(x));
check('全角字母折成半角',       cw('Ａ'), 'a');
// baseFold 会先剥掉首尾标点，所以末尾那个 ％ 在 cjk-width 之前就没了。
// 用夹在中间的写法才测得到全角数字与全角百分号本身。
check('全角数字与百分号',       cw('１６％浓度'), '16%浓度');
check('末尾全角百分号由 baseFold 剥掉', cw('１６％'), '16');
check('阿尔法 → α',             cw('阿尔法螺旋'), 'α螺旋');
check('alpha- → α-',            cw('alpha-螺旋'), 'α-螺旋');
check('全角连字符折成半角',     cw('β－折叠'), 'β-折叠');
check('中文句末标点去掉',       cw('半胱氨酸。'), '半胱氨酸');
check('三字母码 → 中文名',      cn('cys'), '半胱氨酸');
check('中文别名归一',           cn('甲硫氨酸'), '蛋氨酸');
check('门冬氨酸 → 天冬氨酸',    cn('门冬氨酸'), '天冬氨酸');

console.log('== 生化的非等价：不该折的没被放过 ==');
// 这一组是重点。折宽一格，错答就被判成对——学生看到的是一个理直气壮的满分。
check('alphabet 不被当成 alpha 前缀', cw('alphabet'), 'alphabet');
check('谷胺酸（错别字）不等于谷氨酸', cn('谷胺酸') === cn('谷氨酸'), false);
// 单字母码故意不折（见 chem-nomenclature.js）：C/N/P/S/K 同时是元素符号，
// 第 1 题问的是氮、alt 写着 N，全局折的话天冬酰胺会变成那道题的正确答案。
check('单字母 N 不折成天冬酰胺',      cn('N') === cn('天冬酰胺'), false);
check('单字母 C 不折成半胱氨酸',      cn('C') === cn('半胱氨酸'), false);
check('缬氨酸不等于亮氨酸',           cn('缬氨酸') === cn('亮氨酸'), false);
check('Val 不等于 Leu',               cn('val') === cn('leu'), false);

console.log(`== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
