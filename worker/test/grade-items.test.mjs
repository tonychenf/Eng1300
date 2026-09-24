// 判分骨架单测（验收 B5～B13、B16、G6～G9）。
//
// 纯 node，不起服务、不连库：判分是纯函数，用构造数据测得最细。**构造数据取自真实
// 题目的形状**（生化第 1 章的填空、名词解释；文理压力测试里的步骤题、论述题），
// 不是自己编一个方便通过的例子。
//
// 每条断言都按"改成常量能不能变红"验过——验的过程见提交说明。
// 凡是"某个配置生效了"的断言都成对写：默认配置得到 A，改掉配置得到 B。
// 只断言一边的话，测的是"这段代码跑通了"，不是"这个开关有用"。
import { gradeQuestion } from '../src/lib/grade.js';
import { validateItems, parseItemAnswers, toItem, inputGroupsWithoutAnswer } from '../src/lib/question-items.js';
import { resolveNormalizers } from '../src/normalizers/index.js';
import { STRATEGIES, GRADERS } from '../src/graders/index.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};
// 得分率会经过一次六位小数的收敛（浮点求和会漂出 0.30000000000000004 这种值，
// 落到成绩单和 score_rate 列上都难看）。除不尽的比例用容差比，断言的是数学上的那个
// 值，不是实现里那一行 round——否则测的就是"实现和自己一致"。
const near = (desc, got, want) => {
  if (Math.abs(got - want) <= 1e-6) { pass++; }
  else { fail++; console.log(`  FAIL ${desc} (期望 ≈${want}, 实际 ${got})`); }
};
const throws = (desc, fn, wantCode) => {
  let code = null, msg = '';
  try { fn(); } catch (e) { code = e.code || '（没有 code）'; msg = e.message; }
  if (code === wantCode) { pass++; return msg; }
  fail++; console.log(`  FAIL ${desc} (期望抛 ${wantCode}, 实际 ${code}${msg ? '：' + msg.slice(0, 80) : ''})`);
  return msg;
};

// ───────── 构造能力包。形状与 loadPack 的返回值一致，字段名也一致 ─────────
function makePack(typeSpec = {}, rubricPatch = {}) {
  const t = {
    code: 'T', name: '测试题型', isObjective: true, inPractice: true,
    needsAi: false, aiReviewOnMiss: false, widget: 'text',
    answerShape: 'TEXT_SHORT', gradingStrategy: 'EXACT',
    normalizerNames: [], ...typeSpec,
  };
  t.normalizers = resolveNormalizers(t.normalizerNames, '测试题型');
  const rubric = {
    grading: { partialCredit: true, caseSensitive: false, ...(rubricPatch.grading || {}) },
    essay: rubricPatch.essay || { type: 'POINT_HIT', totalScore: 100, openWeightCap: 0.3 },
    mastery: { correctThreshold: 1.0, ...(rubricPatch.mastery || {}) },
  };
  const types = new Map([[t.code, t]]);
  return {
    subjectId: 99, code: 'test', name: '测试学科', rubricVersion: 1,
    rubric, grading: rubric.grading, types,
    typeOf(code) {
      const found = types.get(code);
      if (!found) throw Object.assign(new Error('question_type_not_declared'), { code: 'question_type_not_declared' });
      return found;
    },
    practiceTypes() { return [...types.values()].filter((x) => x.inPractice).map((x) => x.code); },
  };
}
const Q = { question_id: 'Q-TEST', question_type: 'T', answer: '' };
// 得分单元一律按库里那一行的形状构造，免得测的是另一条解析路径
const item = (ord, over = {}) => ({
  item_ord: ord, item_kind: 'BLANK', answer: '', weight: 1,
  ...over,
  ...(over.params ? { params: JSON.stringify(over.params) } : {}),
  ...(over.alt_answers ? { alt_answers: JSON.stringify(over.alt_answers) } : {}),
});
const answers = (obj) => JSON.stringify(obj);

console.log('== B5 部分分：10 空答对 7 ==');
{
  // 生化的多空填空：10 个空，权重齐平，答对前 7 个
  const items = Array.from({ length: 10 }, (_, i) => item(i + 1, { answer: `答案${i + 1}` }));
  const given = {};
  for (let i = 1; i <= 10; i++) given[i] = i <= 7 ? `答案${i}` : '写错了';
  const g = gradeQuestion(makePack(), Q, answers(given), 5, { items });
  check('得分率 = 7/10', g.scoreRate, 7 / 10);
  check('得分 = 得分率 × 本卷赋予该题的分值', g.score, (7 / 10) * 5);
  check('逐空结果有 10 条', g.itemResults.length, 10);
  check('第 8 空记未命中', g.itemResults[7].items[0].hit, 0);
  // 逐项得分要和题目得分率同口径，否则报告上"逐项加起来"对不上总分
  check('逐项得分之和 = 得分率 × 总权重',
    g.itemResults.reduce((a, r) => a + r.scored, 0), g.scoreRate * 10);
  // 不给部分分的学科（英语口径）：同样的作答，半对等于全错
  const strict = gradeQuestion(makePack({}, { grading: { partialCredit: false } }), Q, answers(given), 5, { items });
  check('partialCredit=false 时同一份作答得 0 分', strict.score, 0);
  check('partialCredit=false 时得分率也是 0', strict.scoreRate, 0);
  check('partialCredit=false 时逐项得分也全是 0', strict.itemResults.reduce((a, r) => a + r.scored, 0), 0);
  check('但逐项对错照样留着（学生要看到哪几个空错了）',
    strict.itemResults.filter((r) => r.rate === 1).length, 7);
}

console.log('== B6 无序并列空 ==');
{
  // "参与构成活性中心的酸性氨基酸有＿、＿"——两个空互换位置应当全对
  const items = [
    item(1, { answer: '天冬氨酸', group_key: 'acidic', grading_strategy: 'SET' }),
    item(2, { answer: '谷氨酸', group_key: 'acidic', grading_strategy: 'SET' }),
  ];
  const swapped = gradeQuestion(makePack(), Q, answers({ 1: '谷氨酸', 2: '天冬氨酸' }), 2, { items });
  check('两个空互换判全对', swapped.scoreRate, 1);
  check('互换后拿满分', swapped.score, 2);
  const half = gradeQuestion(makePack(), Q, answers({ 1: '谷氨酸', 2: '丙氨酸' }), 2, { items });
  check('只答对一个是 0.5', half.scoreRate, 1 / 2);
  const dup = gradeQuestion(makePack(), Q, answers({ 1: '谷氨酸', 2: '谷氨酸' }), 2, { items });
  check('同一个答案填两遍只算一次', dup.scoreRate, 1 / 2);
  check('重复的那个空标成未命中', dup.itemResults[0].items[1].hit, 0);
  check('并且说明为什么', dup.itemResults[0].items[1].note, '与前面重复，只计一次');
  // 不归组时顺序就算数——这是 group_key 真正起作用的证据
  const ungrouped = items.map((it) => ({ ...it, group_key: null, grading_strategy: 'EXACT' }));
  const swappedUngrouped = gradeQuestion(makePack(), Q, answers({ 1: '谷氨酸', 2: '天冬氨酸' }), 2, { items: ungrouped });
  check('不归组时互换判全错', swappedUngrouped.scoreRate, 0);
}

console.log('== B6b 开放列举：候选池比空数大 ==');
{
  // "有些蛋白质还含有金属元素如＿、＿、＿、＿等"——可接受 8 种，任填 4 个
  const pool = ['铁', '铜', '锌', '锰', '钼', '钴', '镁', '钙'];
  const params = { pool, requiredCount: 4, alias: { 铁: ['Fe'], 铜: ['Cu'], 锌: ['Zn'] } };
  const items = [1, 2, 3, 4].map((i) => item(i, { group_key: 'metal', grading_strategy: 'SET', params }));
  const all = gradeQuestion(makePack(), Q, answers({ 1: '钼', 2: '钴', 3: '镁', 4: '钙' }), 2, { items });
  check('池里任选 4 个都算全对', all.scoreRate, 1);
  const mixed = gradeQuestion(makePack(), Q, answers({ 1: 'Fe', 2: 'Cu', 3: '钾', 4: '钠' }), 2, { items });
  check('别名算命中、池外的不算', mixed.scoreRate, 2 / 4);
  const dup = gradeQuestion(makePack(), Q, answers({ 1: '铁', 2: 'Fe', 3: '锌', 4: '' }), 2, { items });
  check('同一元素的两种写法只算一个', dup.scoreRate, 2 / 4);

  // 空数与应答数可以不等："卷面给了 5 条横线，答出 3 种即可"
  const five = [1, 2, 3, 4, 5].map((i) => item(i, {
    group_key: 'metal', grading_strategy: 'SET', params: { pool, requiredCount: 3 },
  }));
  const three = gradeQuestion(makePack(), Q, answers({ 1: '铁', 2: '铜', 3: '锌' }), 3, { items: five });
  check('应答数 3、答对 3 个就是满分（哪怕还空着两条线）', three.scoreRate, 1);
  const two = gradeQuestion(makePack(), Q, answers({ 1: '铁', 2: '铜' }), 3, { items: five });
  near('分母是应答数而不是空数', two.scoreRate, 2 / 3);
  const over = gradeQuestion(makePack(), Q,
    answers({ 1: '铁', 2: '铜', 3: '锌', 4: '锰', 5: '钼' }), 3, { items: five });
  check('多填不额外加分', over.scoreRate, 1);
  check('超出应答数的空要说明不计', over.itemResults[0].items[3].note, '超出应答数 3，不计');
  // 要填的比池子里有的还多，学生怎么答都拿不到满分——这是配置错了
  const impossible = [1, 2].map((i) => item(i, {
    group_key: 'm', grading_strategy: 'SET', params: { pool: ['铁', '铜'], requiredCount: 5 },
  }));
  throws('应答数超过候选池时抛错',
    () => gradeQuestion(makePack(), Q, answers({ 1: '铁', 2: '铜' }), 2, { items: impossible }),
    'bad_required_count');
}

console.log('== 输入单元与判定单元不能混用 ==');
{
  // 一道题要么逐空填、要么整段答。混在一起时"整段"从哪到哪没人说得清，
  // 而猜错的后果是采分点拿到半截作答，AI 照样给出一个像样的分数。
  const mixed = [
    item(1, { item_kind: 'BLANK', answer: '甲' }),
    item(2, { item_kind: 'SCORE_POINT', answer: '要点一', group_key: 'p' }),
  ];
  throws('混用时判分抛错',
    () => gradeQuestion(makePack(), Q, answers({ 1: '甲' }), 2, { items: mixed }), 'mixed_item_kinds');
  const problems = validateItems(mixed.map((m) => ({ ...m, group_key: null })),
    { defaultStrategy: 'EXACT', where: '构造题' });
  check('种子阶段也要拦住', problems.some((x) => x.includes('输入单元')), true);
  // 全是判定单元时，每个单元拿到的都是整段原文
  const points = [1, 2].map((i) => item(i, { item_kind: 'SCORE_POINT', answer: `要点${i}`, group_key: 'p' }));
  const parsed = parseItemAnswers('学生写的一整段', points.map((r) => toItem(r, 'X')), 'X');
  check('判定单元拿到整段原文', parsed.get(2), '学生写的一整段');
}

console.log('== B7 别名等价 / B8 非等价守卫 ==');
{
  const items = [item(1, { answer: '半胱氨酸', alt_answers: ['Cys', 'C'] })];
  const mk = (a) => gradeQuestion(makePack({ normalizerNames: ['trim-case'] }), Q, answers({ 1: a }), 1, { items });
  check('答 Cys 判对', mk('Cys').scoreRate, 1);
  check('答 C 判对', mk('C').scoreRate, 1);
  check('答 cys 判对（不区分大小写）', mk('cys').scoreRate, 1);
  check('答全称判对', mk('半胱氨酸').scoreRate, 1);
  // B8：错别字不能被归一化器放过。谷胺酸 / 谷氨酸 只差一个字，正是最容易被
  // "模糊匹配"放过去的那种；宁可判错记错，不可把错答放过。
  const glu = [item(1, { answer: '谷氨酸' })];
  const typo = gradeQuestion(makePack({ normalizerNames: ['trim-case'] }), Q, answers({ 1: '谷胺酸' }), 1, { items: glu });
  check('错别字谷胺酸判错', typo.scoreRate, 0);
  const other = gradeQuestion(makePack({ normalizerNames: ['trim-case'] }), Q, answers({ 1: '半胱氨酸' }), 1, { items: glu });
  check('答成另一个氨基酸判错', other.scoreRate, 0);
}

console.log('== B9 数值容差 ==');
{
  const items = [item(1, { answer: '280nm', grading_strategy: 'NUMERIC', params: { tolerance: 0.005 } })];
  const mk = (a) => gradeQuestion(makePack(), Q, answers({ 1: a }), 1, { items }).scoreRate;
  check('答 280 判对（不写单位视为沿用题干）', mk('280'), 1);
  check('答 280nm 判对', mk('280nm'), 1);
  check('答 280 nm 判对（中间有空格）', mk('280 nm'), 1);
  check('答 280g 判错（单位不符）', mk('280g'), 0);
  check('答 281 判对（1/280 = 0.36% < 0.5%）', mk('281'), 1);
  check('答 282 判错（2/280 = 0.71% > 0.5%）', mk('282'), 0);
  check('答"约 280"判错（不是数值打头）', mk('约 280'), 0);
  // 容差是配置，不是常数：把它放宽，同一份作答的判定要跟着变
  const loose = [item(1, { answer: '280nm', grading_strategy: 'NUMERIC', params: { tolerance: 0.05 } })];
  check('容差放宽到 5% 之后 282 判对',
    gradeQuestion(makePack(), Q, answers({ 1: '282' }), 1, { items: loose }).scoreRate, 1);
  // 标准答案是 0 时相对容差恒等于 0，等于悄悄变成"必须一字不差"
  const zero = [item(1, { answer: '0', grading_strategy: 'NUMERIC', params: { tolerance: 0.005 } })];
  throws('标准答案为 0 而没给绝对容差时抛错',
    () => gradeQuestion(makePack(), Q, answers({ 1: '0' }), 1, { items: zero }), 'numeric_zero_needs_abs_tolerance');
  const zeroAbs = [item(1, { answer: '0', grading_strategy: 'NUMERIC', params: { absTolerance: 0.01 } })];
  check('给了绝对容差之后 0 判对',
    gradeQuestion(makePack(), Q, answers({ 1: '0.005' }), 1, { items: zeroAbs }).scoreRate, 1);
}

console.log('== B10 受限选择 ==');
{
  const items = [item(1, { answer: '高', grading_strategy: 'ENUM', params: { options: ['高', '低'] } })];
  const mk = (a) => gradeQuestion(makePack(), Q, answers({ 1: a }), 1, { items });
  check('答"高"判对', mk('高').scoreRate, 1);
  check('答"低"判错', mk('低').scoreRate, 0);
  check('答枚举外的"中等"判错', mk('中等').scoreRate, 0);
  check('枚举外的答案要说明原因', mk('中等').itemResults[0].items[0].note, '不在题干给定的选项里');
  check('枚举内答错的不带这条说明', mk('低').itemResults[0].items[0].note, undefined);
  // 标准答案不在枚举里是题库配错了，全班都答不对，必须抛错而不是让所有人零分
  const broken = [item(1, { answer: '中等', grading_strategy: 'ENUM', params: { options: ['高', '低'] } })];
  throws('标准答案不在枚举里抛错',
    () => gradeQuestion(makePack(), Q, answers({ 1: '高' }), 1, { items: broken }), 'enum_answer_not_in_options');
}

console.log('== B11 采分点评分 ==');
{
  // 名词解释"肽键"的三个采分点，权重 2 / 2 / 1
  const items = [
    item(1, { item_kind: 'SCORE_POINT', answer: '氨基酸的羧基与另一氨基酸的氨基脱水缩合', weight: 2, group_key: 'p' }),
    item(2, { item_kind: 'SCORE_POINT', answer: '形成的酰胺键即肽键', weight: 2, group_key: 'p' }),
    item(3, { item_kind: 'SCORE_POINT', answer: '具有部分双键性质，不能自由旋转', weight: 1, group_key: 'p' }),
  ];
  const pk = makePack({ needsAi: true, gradingStrategy: 'AI_SCORE_POINTS', isObjective: false });
  const aiResult = { points: { 1: { hit: true }, 2: { hit: true }, 3: { hit: false } } };
  const g = gradeQuestion(pk, Q, '学生的答案', 5, { items, aiResult });
  check('得分率 = 命中权重 / 总权重', g.scoreRate, (2 + 2) / (2 + 2 + 1));
  check('得分 = 得分率 × 本卷分值', g.score, ((2 + 2) / 5) * 5);
  // 命中的是权重 1 的那个点时得分率不同——证明算的是权重不是个数
  const other = gradeQuestion(pk, Q, '学生的答案', 5,
    { items, aiResult: { points: { 1: { hit: false }, 2: { hit: false }, 3: { hit: true } } } });
  check('只命中权重 1 的点时得分率 = 1/5', other.scoreRate, 1 / 5);
  check('没有 AI 结果时记待判而不是 0 分', gradeQuestion(pk, Q, '学生的答案', 5, { items }).isCorrect, null);
  check('待判时分数是 null，不是 0', gradeQuestion(pk, Q, '学生的答案', 5, { items }).score, null);
  check('待判会被标成 pendingAi', gradeQuestion(pk, Q, '学生的答案', 5, { items }).pendingAi, true);
}

console.log('== B12 采分点异常：AI 的 key 与题目对不上 ==');
{
  const items = [1, 2, 3].map((i) => item(i, { item_kind: 'SCORE_POINT', answer: `要点${i}`, group_key: 'p' }));
  const pk = makePack({ needsAi: true, gradingStrategy: 'AI_SCORE_POINTS', isObjective: false });
  const run = (aiResult) => gradeQuestion(pk, Q, '学生的答案', 5, { items, aiResult });
  const msg = throws('少了一个采分点抛 ai_bad_shape',
    () => run({ points: { 1: { hit: true }, 2: { hit: true } } }), 'ai_bad_shape');
  check('报错里说清楚缺的是哪个', msg.includes('3'), true);
  throws('多出一个对不上的 key 也抛',
    () => run({ points: { 1: { hit: true }, 2: { hit: true }, 3: { hit: true }, 9: { hit: true } } }), 'ai_bad_shape');
  throws('hit 不是布尔值时抛',
    () => run({ points: { 1: { hit: '是' }, 2: { hit: true }, 3: { hit: true } } }), 'ai_bad_shape');
  throws('整个 points 都读不到时抛', () => run({ 总分: 3 }), 'ai_bad_shape');
  // 真的一个都没命中，与"读不到"必须分得开
  check('全都没命中是 0 分，不是异常',
    run({ points: { 1: { hit: false }, 2: { hit: false }, 3: { hit: false } } }).scoreRate, 0);
}

console.log('== B13 掌握度归属 ==');
{
  const items = Array.from({ length: 10 }, (_, i) => item(i + 1, { answer: `答案${i + 1}` }));
  const given = {};
  for (let i = 1; i <= 10; i++) given[i] = i <= 7 ? `答案${i}` : '写错了';
  const strict = gradeQuestion(makePack(), Q, answers(given), 5, { items });
  check('默认阈值 1.0 下得分率 0.7 记为答错', strict.isCorrect, 0);
  check('但分数照给', strict.score, 3.5);
  const loose = gradeQuestion(makePack({}, { mastery: { correctThreshold: 0.6 } }), Q, answers(given), 5, { items });
  check('阈值调到 0.6 之后同一份作答记为答对', loose.isCorrect, 1);
  const allRight = {};
  for (let i = 1; i <= 10; i++) allRight[i] = `答案${i}`;
  check('全对在阈值 1.0 下也是答对', gradeQuestion(makePack(), Q, answers(allRight), 5, { items }).isCorrect, 1);
  // 阈值取不到就抛错，不悄悄用 1.0
  throws('评价标准里没有 correctThreshold 时抛错',
    () => gradeQuestion(makePack({}, { mastery: { correctThreshold: null } }), Q, answers(given), 5, { items }),
    'bad_rubric');
}

console.log('== B16 填空的空与采分点走同一段代码 ==');
{
  // 同样的权重分布、同样的命中模式，两种 item_kind 必须给出同一个得分率。
  // 不同的话说明它们走了两条路——而两条路正是 v2 那两张表的下场。
  const weights = [2, 2, 1];
  const blanks = weights.map((w, i) => item(i + 1, { item_kind: 'BLANK', answer: `答案${i + 1}`, weight: w }));
  const points = weights.map((w, i) => item(i + 1, {
    item_kind: 'SCORE_POINT', answer: `要点${i + 1}`, weight: w, group_key: 'p',
  }));
  const blankRate = gradeQuestion(makePack(), Q, answers({ 1: '答案1', 2: '答案2', 3: '错' }), 5, { items: blanks }).scoreRate;
  const pointRate = gradeQuestion(
    makePack({ needsAi: true, gradingStrategy: 'AI_SCORE_POINTS', isObjective: false }), Q, '答案', 5,
    { items: points, aiResult: { points: { 1: { hit: true }, 2: { hit: true }, 3: { hit: false } } } },
  ).scoreRate;
  check('空与采分点在同样的命中模式下得分率相同', blankRate, pointRate);
  check('两者的逐项结果形状也相同', blankRate === pointRate, true);

  // 结构上的证据：调判分器的地方只有 grade.js 一处
  const src = readFileSync(new URL('../src/lib/grade.js', import.meta.url), 'utf8');
  check('grade.js 里只有一处调用 gradeGroup', (src.match(/\.gradeGroup\(/g) || []).length, 1);
}

console.log('== G6 步骤依赖 ==');
{
  // 三步解答题：第 2 步算错，第 3 步基于错误结果但方法正确
  const steps = [
    item(1, { item_kind: 'STEP', answer: '列出方程', group_key: 's' }),
    item(2, { item_kind: 'STEP', answer: '解得 y=3', group_key: 's' }),
    item(3, { item_kind: 'STEP', answer: '代入求得 x=2', group_key: 's', params: { dependsOn: [2] } }),
  ];
  const pk = makePack({ needsAi: true, gradingStrategy: 'AI_SCORE_POINTS', isObjective: false });
  const ai = { points: { 1: { hit: true }, 2: { hit: false }, 3: { hit: false, methodOk: true } } };
  const method = gradeQuestion(pk, Q, '解答', 6, { items: steps, aiResult: ai });
  near('METHOD_ONLY 下第 3 步给后续过程分', method.scoreRate, 2 / 3);
  check('给分的理由要写进逐项结果', method.itemResults[0].items[2].note, '前置步骤错，方法正确，给后续过程分');

  const strictSteps = steps.map((s, i) => (i === 2
    ? { ...s, params: JSON.stringify({ dependsOn: [2], dependencyMode: 'STRICT' }) } : s));
  const strict = gradeQuestion(pk, Q, '解答', 6, { items: strictSteps, aiResult: ai });
  near('STRICT 下第 3 步不给分', strict.scoreRate, 1 / 3);

  // 前置步骤对了的话，第 3 步就按它自己的结果判，不受 methodOk 影响
  const ok = { points: { 1: { hit: true }, 2: { hit: true }, 3: { hit: false, methodOk: true } } };
  near('前置步骤对时第 3 步按 hit 判', gradeQuestion(pk, Q, '解答', 6, { items: steps, aiResult: ok }).scoreRate, 2 / 3);
  // 带依赖的步骤一定要 AI 分别报告方法与结果，漏了要当场发现
  throws('带依赖却没报 methodOk 时抛 ai_bad_shape',
    () => gradeQuestion(pk, Q, '解答', 6,
      { items: steps, aiResult: { points: { 1: { hit: true }, 2: { hit: false }, 3: { hit: false } } } }),
    'ai_bad_shape');
  // 依赖指到组外 / 指到后面都判不了
  const badDep = [
    item(1, { item_kind: 'STEP', answer: 'a', group_key: 's' }),
    item(2, { item_kind: 'STEP', answer: 'b', group_key: 's', params: { dependsOn: [5] } }),
  ];
  throws('依赖指向不存在的单元时抛',
    () => gradeQuestion(pk, Q, '解答', 6,
      { items: badDep, aiResult: { points: { 1: { hit: true }, 2: { hit: true, methodOk: true } } } }),
    'bad_depends_on');
}

console.log('== G7 开放采分点 ==');
{
  // 论述题：三个预设论点 + 一个开放点（最多计 2 个）
  const items = [
    item(1, { item_kind: 'SCORE_POINT', answer: '论点一', weight: 2, group_key: 'p' }),
    item(2, { item_kind: 'SCORE_POINT', answer: '论点二', weight: 2, group_key: 'p' }),
    item(3, { item_kind: 'SCORE_POINT', answer: '论点三', weight: 2, group_key: 'p' }),
    item(4, {
      item_kind: 'SCORE_POINT', answer: '（其他言之成理的论点）', weight: 1, group_key: 'p',
      params: { openEnded: true, maxCount: 2, guide: '须紧扣题干、有史实或法条支撑' },
    }),
  ];
  const pk = makePack({ needsAi: true, gradingStrategy: 'AI_SCORE_POINTS', isObjective: false });
  const run = (count) => gradeQuestion(pk, Q, '论述', 10, {
    items,
    aiResult: { points: { 1: { hit: true }, 2: { hit: true }, 3: { hit: false }, 4: { count } } },
  });
  near('开放点答出 1 个记一半权重', run(1).scoreRate, (2 + 2 + 0.5) / 7);
  near('开放点答出 2 个记满', run(2).scoreRate, (2 + 2 + 1) / 7);
  check('超过 maxCount 不再计', run(5).scoreRate, run(2).scoreRate);
  check('超额时要在逐项结果里说明', run(5).itemResults[0].items[3].note, '答出 5 个，按上限计 2 个');
  near('一个都没答出记 0', run(0).scoreRate, (2 + 2) / 7);
  throws('开放点要的是个数，给布尔值时抛',
    () => gradeQuestion(pk, Q, '论述', 10, {
      items, aiResult: { points: { 1: { hit: true }, 2: { hit: true }, 3: { hit: true }, 4: { hit: true } } },
    }), 'ai_bad_shape');
}

console.log('== G8 开放采分点的权重上限 ==');
{
  const mk = (openWeight) => [
    { item_ord: 1, item_kind: 'SCORE_POINT', answer: '预设一', weight: 1, group_key: 'p' },
    { item_ord: 2, item_kind: 'SCORE_POINT', answer: '预设二', weight: 1, group_key: 'p' },
    {
      item_ord: 3, item_kind: 'SCORE_POINT', answer: '（其他论点）', weight: openWeight, group_key: 'p',
      params: JSON.stringify({ openEnded: true, maxCount: 2, guide: '言之成理' }),
    },
  ];
  const opts = { openWeightCap: 0.3, defaultStrategy: 'AI_SCORE_POINTS', where: '构造题' };
  // 2 + 2 + 0.8 里开放点占 0.8/2.8 = 28.6%，没超
  check('占比 28.6% 时通过', validateItems(mk(0.8), opts).length, 0);
  // 占 1.5/3.5 = 42.9%，超了
  const over = validateItems(mk(1.5), opts);
  check('占比 42.9% 时报错', over.length, 1);
  check('报错里说清楚占了多少', over[0].includes('43%'), true);
  // 上限是配置：调高之后同一组单元就合法了
  check('上限调到 0.5 之后同一组通过',
    validateItems(mk(1.5), { ...opts, openWeightCap: 0.5 }).length, 0);
  // 开放点只能用在主观题上
  const onBlank = [{
    item_ord: 1, item_kind: 'BLANK', answer: 'x', weight: 1,
    params: JSON.stringify({ openEnded: true, maxCount: 1, guide: 'g' }),
  }];
  check('填空的空不能设成开放采分点',
    validateItems(onBlank, { ...opts, defaultStrategy: 'EXACT' }).some((p) => p.includes('BLANK')), true);
  const noGuide = [{
    item_ord: 1, item_kind: 'SCORE_POINT', answer: 'x', weight: 1,
    params: JSON.stringify({ openEnded: true, maxCount: 1 }),
  }];
  check('开放点没写 guide 要报错',
    validateItems(noGuide, opts).some((p) => p.includes('guide')), true);
}

console.log('== G9 分档评分 ==');
{
  const bands = [
    { level: 4, name: '一类文', range: [17, 20], desc: '论点鲜明，论据充分' },
    { level: 3, name: '二类文', range: [13, 16], desc: '论点明确，论据较充分' },
    { level: 2, name: '三类文', range: [8, 12], desc: '有论点但论据单薄' },
    { level: 1, name: '四类文', range: [0, 7], desc: '偏离题意或结构混乱' },
  ];
  const pk = makePack(
    { needsAi: true, gradingStrategy: 'AI_LEVEL_BANDED', isObjective: false, answerShape: 'TEXT_LONG' },
    { essay: { type: 'LEVEL_BANDED', totalScore: 20, bands, requireReason: true } },
  );
  const run = (aiResult) => gradeQuestion(pk, Q, '一篇申论', 20, { aiResult });
  const g = run({ level: 3, score: 15, reason: '论点明确，论据较充分，结构完整' });
  check('分数落在该档区间内', g.score >= 13 && g.score <= 16, true);
  check('得分率 = 分数 / 该题满分', g.scoreRate, 15 / 20);
  throws('没给落档理由时抛 ai_bad_shape', () => run({ level: 3, score: 15 }), 'ai_bad_shape');
  throws('分数落在档外时抛（不夹到区间里）',
    () => run({ level: 1, score: 19, reason: '写得好' }), 'ai_bad_shape');
  throws('档次不在标准里时抛', () => run({ level: 9, score: 15, reason: '好' }), 'ai_bad_shape');
  // requireReason 是配置：关掉之后同一份结果就该通过
  const noReason = makePack(
    { needsAi: true, gradingStrategy: 'AI_LEVEL_BANDED', isObjective: false, answerShape: 'TEXT_LONG' },
    { essay: { type: 'LEVEL_BANDED', totalScore: 20, bands, requireReason: false } },
  );
  check('关掉 requireReason 之后不给理由也能判',
    gradeQuestion(noReason, Q, '一篇申论', 20, { aiResult: { level: 3, score: 15 } }).scoreRate, 15 / 20);
}

console.log('== 单元素退化：英语现有路径 ==');
{
  // 没有得分单元的题直接用 questions.answer，行为必须与蓝本一致
  const en = makePack({ normalizerNames: ['choice'], gradingStrategy: 'EXACT' }, { grading: { partialCredit: false } });
  const q = { question_id: 'E1', question_type: 'T', answer: 'B' };
  check('选项字母前后的标点不影响判定', gradeQuestion(en, q, 'b.', 1).isCorrect, 1);
  check('选错判 0 分', gradeQuestion(en, q, 'C', 1).score, 0);
  check('没有得分单元时 itemResults 是 null', gradeQuestion(en, q, 'B', 1).itemResults, null);
  const fill = makePack({ normalizerNames: ['en-spelling'], aiReviewOnMiss: true }, { grading: { partialCredit: false } });
  const fq = { question_id: 'E2', question_type: 'T', answer: 'traveled' };
  check('英式拼写判对', gradeQuestion(fill, fq, 'travelled', 2).score, 2);
  check('判错的填空要交 AI 复核', gradeQuestion(fill, fq, 'travel', 2).needsAiReview, true);
  // 空白作答不送 AI 复核：没作答不是"判错"，送去复核既费钱又没有意义
  check('空白作答判 0 分', gradeQuestion(fill, fq, '', 2).score, 0);
  check('空白作答不送复核', gradeQuestion(fill, fq, '   ', 2).needsAiReview, false);
  check('空白作答的得分率是 0 而不是 null', gradeQuestion(fill, fq, '', 2).scoreRate, 0);
  // 满分不走乘法，分值原样返回（1 × 2.5 走一遍四舍五入会多一层精度损失）
  check('满分时分值原样返回', gradeQuestion(fill, fq, 'traveled', 2.5).score, 2.5);
  // 题库里没有答案的题不该进抽题池，真判到了要抛错而不是让全班一起错
  throws('标准答案为空时抛错',
    () => gradeQuestion(fill, { question_id: 'E3', question_type: 'T', answer: '' }, 'x', 1), 'item_without_answer');
}

console.log('== 待判与 0 分必须分得开 ==');
{
  const essay = makePack({ needsAi: true, gradingStrategy: 'AI_DIMENSION', isObjective: false, inPractice: false });
  const q = { question_id: 'E4', question_type: 'T', answer: '' };
  const g = gradeQuestion(essay, q, '', 30);
  check('没写作文也是待判，不是 0 分', g.score, null);
  check('待判的 isCorrect 是 null', g.isCorrect, null);
  const manual = makePack({ gradingStrategy: 'MANUAL', isObjective: false });
  const m = gradeQuestion(manual, { question_id: 'E5', question_type: 'T', answer: '参考答案' }, '学生答案', 10);
  check('人工阅卷记待判', m.pendingManual, true);
  check('人工阅卷不自动给分', m.score, null);
}

console.log('== 作答拆到单元：读不出来要抛错，不能静默丢掉 ==');
{
  const items = [item(1, { answer: 'a' }), item(2, { answer: 'b' })].map((r) => toItem(r, 'X'));
  check('缺的键算未作答', parseItemAnswers('{"1":"a"}', items, 'X').get(2), '');
  check('作答按序号对上号', parseItemAnswers('{"2":"b","1":"a"}', items, 'X').get(1), 'a');
  throws('多单元题收到裸字符串时抛', () => parseItemAnswers('a、b', items, 'X'), 'item_answer_unreadable');
  throws('键对不上题目时抛', () => parseItemAnswers('{"9":"x"}', items, 'X'), 'item_answer_unknown_ord');
  const one = [item(1, { answer: 'a' })].map((r) => toItem(r, 'X'));
  check('单单元题整串就是答案', parseItemAnswers('a', one, 'X').get(1), 'a');
  check('单单元题里的大括号不会被当成 JSON', parseItemAnswers('{不是 JSON}', one, 'X').get(1), '{不是 JSON}');
  check('单单元题也认按序号写的 JSON', parseItemAnswers('{"1":"a"}', one, 'X').get(1), 'a');
}

console.log('== 注册表本身 ==');
{
  check('八个策略都在注册表里', STRATEGIES.length, 8);
  for (const [code, g] of Object.entries(GRADERS)) {
    check(`${code} 的 strategy 字段与注册名一致`, g.strategy, code);
  }
  throws('未实现的策略在归组时就抛，不静默退回 EXACT',
    () => gradeQuestion(makePack({ gradingStrategy: 'SEQUENCE' }),
      { question_id: 'X', question_type: 'T', answer: 'a' }, 'a', 1), 'strategy_not_implemented');
  throws('题型声明 needs_ai=1 却一个 AI 单元组都没有时抛',
    () => gradeQuestion(makePack({ gradingStrategy: 'EXACT', needsAi: true }),
      { question_id: 'X', question_type: 'T', answer: 'a' }, 'a', 1), 'ai_type_without_ai_group');
  throws('题型声明 needs_ai=0 却配了 AI 策略时抛',
    () => gradeQuestion(makePack({ gradingStrategy: 'AI_SCORE_POINTS', needsAi: false }),
      { question_id: 'X', question_type: 'T', answer: 'a' }, 'a', 1), 'ai_strategy_on_non_ai_type');
  throws('同组声明两种策略时抛',
    () => gradeQuestion(makePack(), Q, answers({ 1: 'a', 2: 'b' }), 1, {
      items: [
        item(1, { answer: 'a', group_key: 'g', grading_strategy: 'EXACT' }),
        item(2, { answer: 'b', group_key: 'g', grading_strategy: 'SET' }),
      ],
    }), 'group_strategy_conflict');
  throws('SET 组内权重不齐时抛',
    () => gradeQuestion(makePack(), Q, answers({ 1: 'a', 2: 'b' }), 1, {
      items: [
        item(1, { answer: 'a', group_key: 'g', grading_strategy: 'SET', weight: 2 }),
        item(2, { answer: 'b', group_key: 'g', grading_strategy: 'SET', weight: 1 }),
      ],
    }), 'set_weights_uneven');
}

// ── inputGroupsWithoutAnswer：校对页确认那道门的判据（N6c）────────────────
//
// **判据必须和判分器一致。** 自己另立一套"answer 非空"的话，SET 那类整组共用
// params.pool 的题会被全部误伤——它们的逐空 answer 本来就是空的，判分照样判得了。
// 反过来写松了，"确认过但没有答案"的题会发到学员面前，判分时才抛
// item_without_answer，学员看到的是一次失败的交卷。
{
  const blank = (ord, over = {}) => ({
    item_ord: ord, item_kind: 'BLANK', group_key: null,
    answer: null, alt_answers: null, params: null, ...over,
  });
  check('都有答案时没问题',
    inputGroupsWithoutAnswer([blank(1, { answer: '氮' }), blank(2, { answer: '16' })]).length, 0);
  check('一个空没答案就点名它',
    inputGroupsWithoutAnswer([blank(1, { answer: '氮' }), blank(2)]).length, 1);
  // 取 [0] 之前先兜一层：判据坏成"永远没问题"时这里会是 undefined，
  // 直接 .includes 会抛异常——那样连小结都打不出来，红得不明不白。
  check('点名的是第 2 空',
    (inputGroupsWithoutAnswer([blank(1, { answer: '氮' }), blank(2)])[0] || '').includes('第 2 空'), true);
  // 只有别名也算有答案：acceptedForms 把 answer 与 alt_answers 一起折
  check('只有别名也算有答案',
    inputGroupsWithoutAnswer([blank(1, { alt_answers: '["N"]' })]).length, 0);
  check('别名是空数组不算',
    inputGroupsWithoutAnswer([blank(1, { alt_answers: '[]' })]).length, 1);
  check('别名全是空白字符串不算',
    inputGroupsWithoutAnswer([blank(1, { alt_answers: '["  "]' })]).length, 1);
  check('答案是空白字符串不算',
    inputGroupsWithoutAnswer([blank(1, { answer: '   ' })]).length, 1);
  // SET：整组共用候选池，逐空 answer 为空是正常的（graders/set.js 的口径）
  const pooled = [
    blank(1, { group_key: 'g1', params: '{"pool":["碳","氢","氧"]}' }),
    blank(2, { group_key: 'g1', params: '{"pool":["碳","氢","氧"]}' }),
  ];
  check('候选池组放行（不能比判分器严）', inputGroupsWithoutAnswer(pooled).length, 0);
  check('候选池是空数组时仍要点名',
    inputGroupsWithoutAnswer([blank(1, { group_key: 'g1', params: '{"pool":[]}' })]).length, 1);
  // 同组只要有一个单元带答案，整组就判得了（SET 不写 pool 时退化成集合相等）
  check('同组有一个带答案就算整组有',
    inputGroupsWithoutAnswer([
      blank(1, { group_key: 'g1', answer: '天冬氨酸' }), blank(2, { group_key: 'g1' }),
    ]).length, 0);
  check('group_key 为空的单元各自成组（不会互相顶包）',
    inputGroupsWithoutAnswer([blank(1, { answer: '甲' }), blank(2), blank(3)]).length, 2);
  // 判定单元不查：开放采分点、交给 AI 判的，没有字面答案是正常的
  check('采分点不查', inputGroupsWithoutAnswer([
    { item_ord: 1, item_kind: 'SCORE_POINT', group_key: null, answer: null, alt_answers: null, params: null },
  ]).length, 0);
  check('解答步骤不查', inputGroupsWithoutAnswer([
    { item_ord: 1, item_kind: 'STEP', group_key: null, answer: null, alt_answers: null, params: null },
  ]).length, 0);
  check('没有单元的题不报问题', inputGroupsWithoutAnswer([]).length, 0);
  // 坏 JSON 当成"没有"，不能整个抛错——这个函数要能对库里任意一行给出结论
  check('alt_answers 是坏 JSON 时当成没有，不抛错',
    inputGroupsWithoutAnswer([blank(1, { alt_answers: '{坏' })]).length, 1);
  check('params 是坏 JSON 时当成没有，不抛错',
    inputGroupsWithoutAnswer([blank(1, { params: '{坏' })]).length, 1);
}

console.log(`== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
