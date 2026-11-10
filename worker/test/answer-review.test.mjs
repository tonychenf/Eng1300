// 批量核答案的纯函数（改进阶段 2 第三期 D）：答案算不算一样、疑点怎么排、答案页识别结果怎么读、AI 回的把握和题面问题怎么收。纯 node。
import { sameAnswer, reviewRank, parseAnswerPage } from '../src/routes/admin-answers.js';
import { shapeFlags } from '../src/lib/ai-answer.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};
const throwsCode = (fn) => { try { fn(); return 'no error'; } catch (e) { return e.code; } };

console.log('== 两个答案算不算一样 ==');
check('大小写、前后空白不算不一样', sameAnswer(' b ', 'B'), true);
check('全角字母和半角一样', sameAnswer('Ｂ', 'B'), true);
check('句末标点不算', sameAnswer('absorb.', 'absorb'), true);
check('中间的空白不算', sameAnswer('take  off', 'takeoff'), true);
check('不同的字母不一样', sameAnswer('A', 'B'), false);
check('两边都空不算一样（空不是"一致"）', sameAnswer('', ''), false);
check('一边是 null 不一样', sameAnswer(null, 'A'), false);

console.log('== 疑点和排位 ==');
const q = (o = {}) => ({ stem_problem: null, book_answer: null, handwritten: null, confidence: '高', answer_state: '待核', ...o });
const kinds = (r) => `${r.rank}:${r.reasons.map((x) => x.kind).join('+')}`;
check('没有疑点 → 3', kinds(reviewRank(q(), 'A')), '3:');
check('题面有问题排最前（0），哪怕也拿不准', kinds(reviewRank(q({ stem_problem: '没有正确选项', confidence: '低' }), 'A')), '0:stem+unsure');
check('和原书不一致 → 1', kinds(reviewRank(q({ book_answer: 'B' }), 'A')), '1:book');
check('和原书一致 → 不算疑点', kinds(reviewRank(q({ book_answer: 'a' }), 'A')), '3:');
check('和手写不一致 → 1', kinds(reviewRank(q({ handwritten: 'C' }), 'A')), '1:hand');
check('把握中、低 → 2；高、读不懂（null）不算', [reviewRank(q({ confidence: '中' }), 'A').rank, reviewRank(q({ confidence: '低' }), 'A').rank, reviewRank(q({ confidence: null }), 'A').rank], [2, 2, 3]);
check('还没答案 → 2；没答案时手写对不上也不算"不一致"（没东西可比）', kinds(reviewRank(q({ handwritten: 'C' }), null)), '2:missing');
check('原书比对的疑点说出两边各是什么', reviewRank(q({ book_answer: 'B' }), 'A').reasons[0].text.includes('「B」') && reviewRank(q({ book_answer: 'B' }), 'A').reasons[0].text.includes('「A」'), true);

console.log('== 答案页识别结果 ==');
check('读出题号 → 答案', [...parseAnswerPage('{"answers":[{"no":1,"answer":"C"},{"no":2,"answer":" absorb "}]}')], [[1, 'C'], [2, 'absorb']]);
check('包着 ```json 的也认', parseAnswerPage('```json\n{"answers":[{"no":3,"answer":"D"}]}\n```').get(3), 'D');
check('题号是字符串数字也认', parseAnswerPage('{"answers":[{"no":"4","answer":"B"}]}').get(4), 'B');
check('题号不是整数、答案空的丢掉', parseAnswerPage('{"answers":[{"no":"x","answer":"B"},{"no":5,"answer":""},{"no":6.5,"answer":"A"}]}').size, 0);
check('不是 JSON → answer_page_bad_shape', throwsCode(() => parseAnswerPage('第 1 题 C')), 'answer_page_bad_shape');
check('没有 answers 数组 → answer_page_bad_shape', throwsCode(() => parseAnswerPage('{"items":[]}')), 'answer_page_bad_shape');
check('报错里带顶层键名', (() => { try { parseAnswerPage('{"items":[]}'); } catch (e) { return e.message.includes('items'); } })(), true);

console.log('== AI 回的把握和题面问题 ==');
check('高 / 中 / 低 原样收', ['高', '中', '低'].map((c) => shapeFlags({ confidence: c }).confidence), ['高', '中', '低']);
check('照抄示例"高|中|低"→ 当没给', shapeFlags({ confidence: '高|中|低' }).confidence, null);
check('别的写法（high、90%）→ 当没给', [shapeFlags({ confidence: 'high' }).confidence, shapeFlags({ confidence: '90%' }).confidence], [null, null]);
check('题面问题：一句话收下', shapeFlags({ stemProblem: '选项 C 和 D 一样' }).stemProblem, '选项 C 和 D 一样');
check('"null""无""没有"、太短的 → 没问题', ['null', '无', '没有', 'None', '好', null, 3].map((s) => shapeFlags({ stemProblem: s }).stemProblem), [null, null, null, null, null, null, null]);
check('太长的截到 200 字', shapeFlags({ stemProblem: '题'.repeat(300) }).stemProblem.length, 200);
check('什么都没回 → 两项都空', shapeFlags(undefined), { confidence: null, stemProblem: null });

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
