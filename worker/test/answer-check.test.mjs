// 标准答案自检 answerKeyProblems（2026-10-07），纯 node，不起服务。
//
// 自检的判据就是判分器本身：按标准答案作答拿不到满分、或判分器根本判不了，就报出来。
// 这里逐条断"哪一种配错了会被报出来、说的是什么"，每条都成对：配对了 → 没问题，配错了 → 点名。
// 只断一边的话，自检整个返回空数组也能通过一半。
// 真实题库（生化第 1 章 34 道、英语 1020 道）过不过自检，在 bio-exam / deploy-local 里用真能力包测。
import { answerKeyProblems } from '../src/lib/answer-check.js';
import { resolveNormalizers } from '../src/normalizers/index.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};
const says = (problems, re) => problems.some((p) => re.test(p));

// 能力包：形状与 loadPack 的返回值一致。题型照生化的声明写（填空 EXACT、名词解释按采分点、作文按维度）
function makePack() {
  const types = new Map();
  const add = (code, strategy, extra = {}) => {
    const t = { code, name: code, needsAi: false, aiReviewOnMiss: false, gradingStrategy: strategy,
      normalizerNames: ['trim-case'], ...extra };
    t.normalizers = resolveNormalizers(t.normalizerNames, code);
    types.set(code, t);
  };
  add('fill_text', 'EXACT');
  add('single_choice', 'EXACT', { normalizerNames: ['choice'] });
  add('term_explain', 'AI_SCORE_POINTS', { needsAi: true });
  add('essay', 'AI_DIMENSION', { needsAi: true });
  const rubric = {
    grading: { partialCredit: true, caseSensitive: false },
    essay: { type: 'POINT_HIT', totalScore: 100, openWeightCap: 0.4 },
    mastery: { correctThreshold: 1.0 },
  };
  return {
    subjectId: 1, code: 'biochem', name: '生化', rubricVersion: 1, rubric, grading: rubric.grading, types,
    typeOf(c) {
      const t = types.get(c);
      if (!t) throw Object.assign(new Error(`question_type_not_declared: 没有声明题型 ${JSON.stringify(c)}`), { code: 'question_type_not_declared' });
      return t;
    },
  };
}
const pack = makePack();
const q = (type, answer = null) => ({ question_id: 't', question_type: type, answer });
const row = (ord, extra = {}) => ({
  item_ord: ord, item_kind: 'BLANK', grading_strategy: null, group_key: null,
  answer: null, alt_answers: null, weight: 1, params: null, ...extra,
});
const P = (o) => JSON.stringify(o);

console.log('== 受限选择（ENUM）：第 1 章 q04 那次 ==');
const enumRows = (params, answer = '低') => [row(1, { grading_strategy: 'ENUM', answer, params: P(params) })];
check('枚举写在 params.enum、答案在里面：没问题', answerKeyProblems(pack, q('fill_text'), enumRows({ enum: ['高', '低'] })).length, 0);
check('枚举写在 params.options 也认', answerKeyProblems(pack, q('fill_text'), enumRows({ options: ['高', '低'] })).length, 0);
const badEnum = answerKeyProblems(pack, q('fill_text'), enumRows({ enum: ['高', '中'] }));
check('答案不在枚举里：点名是 #1、说出不在枚举里', says(badEnum, /#1.*不在枚举/), true);
check('两处都写了、写得不一样：报出来', says(answerKeyProblems(pack, q('fill_text'),
  enumRows({ enum: ['高', '低'], options: ['高', '中'] })), /不一致/), true);
check('枚举是空的：报出来', answerKeyProblems(pack, q('fill_text'), enumRows({ enum: [] })).length > 0, true);

console.log('== 候选池（SET） ==');
const pool = (params, n = 2, weights = []) => Array.from({ length: n }, (_, i) => row(i + 1, {
  grading_strategy: 'SET', group_key: 'g', weight: weights[i] ?? 1, ...(i === 0 ? { params: P(params) } : {}),
}));
check('2 个空、池里 2 个、要填 2 个：没问题', answerKeyProblems(pack, q('fill_text'), pool({ pool: ['甲', '乙'], requiredCount: 2 })).length, 0);
check('4 个空、池里 8 个、任填 4 个：没问题',
  answerKeyProblems(pack, q('fill_text'), pool({ pool: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], requiredCount: 4 }, 4)).length, 0);
check('要填 3 个、池里只有 2 个：说清"要填 3 个，候选池只有 2 个"',
  says(answerKeyProblems(pack, q('fill_text'), pool({ pool: ['甲', '乙'], requiredCount: 3 }, 3)), /要填 3 个，候选池只有 2 个/), true);
check('池里两个写法归一化后撞了（不分大小写的 Fe 与 fe）：说清判不了是哪一个',
  says(answerKeyProblems(pack, q('fill_text'), pool({ pool: ['Fe', 'fe'], requiredCount: 2 })), /归一化之后都是/), true);
check('同组的空权重不一样：报出来',
  says(answerKeyProblems(pack, q('fill_text'), pool({ pool: ['甲', '乙'], requiredCount: 2 }, 2, [1, 2])), /权重不一致/), true);

console.log('== 有没有答案 ==');
check('单答案题有答案：没问题', answerKeyProblems(pack, q('single_choice', 'C'), []).length, 0);
check('单答案题答案是空的：说"没有标准答案"', says(answerKeyProblems(pack, q('single_choice', '  '), []), /没有标准答案/), true);
check('多空题有一空没答案：点名那一空', says(answerKeyProblems(pack, q('fill_text'),
  [row(1, { grading_strategy: 'EXACT', answer: 'a' }), row(2, { grading_strategy: 'EXACT' })]), /第 2 空没有标准答案/), true);
check('答案只写在"也认的写法"里：照样算有', answerKeyProblems(pack, q('fill_text'),
  [row(1, { grading_strategy: 'EXACT', alt_answers: P(['H2S']) })]).length, 0);

console.log('== 采分点（名词解释、问答） ==');
const pts = (n, extra = () => ({})) => Array.from({ length: n }, (_, i) => row(i + 1, {
  item_kind: 'SCORE_POINT', answer: `要点${i + 1}`, ...extra(i + 1) }));
check('3 个有内容的采分点：没问题', answerKeyProblems(pack, q('term_explain'), pts(3)).length, 0);
const none = answerKeyProblems(pack, q('term_explain', '一整段参考答案'), []);
check('一个采分点都没有（老的上传章节）：说"没有采分点"、指到校对页', says(none, /没有采分点.*校对页/), true);
check('有一个采分点没写内容：点名', says(answerKeyProblems(pack, q('term_explain'),
  pts(3, (o) => (o === 2 ? { answer: ' ' } : {}))), /第 2 个采分点没有内容/), true);
// 依赖只能指向同一组里序号更小的点（解答题的几步归在一个组里；判分器同一条规矩）
check('依赖指到同组后面的点：报出来', answerKeyProblems(pack, q('term_explain'),
  pts(2, (o) => ({ group_key: 'g', ...(o === 1 ? { params: P({ dependsOn: [2] }) } : {}) }))).length > 0, true);
check('依赖指到同组前面的点：没问题', answerKeyProblems(pack, q('term_explain'),
  pts(2, (o) => ({ group_key: 'g', ...(o === 2 ? { params: P({ dependsOn: [1] }) } : {}) }))).length, 0);
check('依赖指到别的组：报出来', says(answerKeyProblems(pack, q('term_explain'),
  pts(2, (o) => (o === 2 ? { params: P({ dependsOn: [1] }) } : {}))), /不在同一个单元组里/), true);
check('开放采分点写了上限和说明：没问题', answerKeyProblems(pack, q('term_explain'),
  pts(4, (o) => (o === 4 ? { params: P({ openEnded: true, maxCount: 2, guide: '任一合理的调节方式' }) } : {}))).length, 0);
check('开放采分点没写上限：报出来', says(answerKeyProblems(pack, q('term_explain'),
  pts(4, (o) => (o === 4 ? { params: P({ openEnded: true, guide: 'x' }) } : {}))), /maxCount/), true);
check('开放采分点权重超过上限（rubric 的 0.4）：报出来', says(answerKeyProblems(pack, q('term_explain'),
  pts(2, (o) => (o === 2 ? { weight: 3, params: P({ openEnded: true, maxCount: 2, guide: 'x' }) } : {}))), /上限是 40%/), true);
check('一道题里逐空作答的空和采分点混用：报出来', answerKeyProblems(pack, q('term_explain'),
  [...pts(1), row(2, { answer: 'x' })]).length > 0, true);

console.log('== 判不了的不判 ==');
check('作文（维度打分）：没有标准答案可喂，不报问题', answerKeyProblems(pack, q('essay'), []).length, 0);
check('没声明的题型：报出来', says(answerKeyProblems(pack, q('nope', 'x'), []), /没有声明题型/), true);

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
