// AI 拆题导入的纯函数（改进阶段 2 第三期）：体检规则逐条、拆题结果校验与跨段并回、读页码、草稿拼题库文件。纯 node。
// 每条体检规则一个故意做坏的样本；好样本（转写稿原样拆出来的）一条都不该报——不报假警。
import { checkDraft, pageQuickIssues, optionLetters, blankNumbers, altDiffs } from '../src/lib/import-checks.js';
import { validateSplit, mergeChunks, chunkPages, assignIds, SPLIT_PAGES_PER_CALL } from '../src/lib/import-split.js';
import { takePrintedPage } from '../src/lib/import-queue.js';
import { draftToGroupFile } from '../src/routes/admin-import-jobs.js';
import { TRUTH_PAGES } from '../src/ocr-bench/truth-data.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};
const clone = (x) => JSON.parse(JSON.stringify(x));
const TYPES = { single_choice: { widget: 'choice' }, spell_word: { widget: 'text' } };

// 好样本：转写稿第 121、122 页的选择题照原样拆（和替身拆出来的一个样）
function goodDraft() {
  const qs = [];
  for (const [pageNo, page] of [[1, 121], [2, 122]]) {
    const t = TRUTH_PAGES.find((p) => p.page === page);
    for (const block of t.text.split(/\n(?=\d+\. )/)) {
      const [first, ...rest] = block.split('\n');
      const m = first.match(/^(\d+)\.\s+(.*)$/);
      const options = [...rest.join('  ').matchAll(/([A-D])\)\s*(.+?)(?=\s{2,}[A-D]\)|$)/g)].map((o) => `${o[1]}. ${o[2].trim()}`);
      qs.push({ no: Number(m[1]), questionType: 'single_choice', stem: m[2], options, pageNo });
    }
  }
  const d = { sections: [{ type: '选择填空', title: '选择题', passage: null, printedCount: null, questions: qs }] };
  assignIds(d.sections);
  return d;
}
const goodPages = () => [121, 122].map((page, i) => ({ pageNo: i + 1, printedPage: page, status: '已识别', text: TRUTH_PAGES.find((p) => p.page === page).text, altDiffs: [] }));
const rulesOf = (issues) => [...new Set(issues.map((i) => i.rule))].sort().join(',');

console.log('== 好样本：转写稿原样拆出来，一处都不报 ==');
{
  const d = goodDraft();
  const n = TRUTH_PAGES.find((p) => p.page === 121).questions.length + TRUTH_PAGES.find((p) => p.page === 122).questions.length;
  check(`拆出 ${n} 题`, d.sections[0].questions.length, n);
  check('体检一处都不报', checkDraft(d, goodPages(), TYPES).map((i) => i.id), []);
}

console.log('== 体检规则逐条（每条一个做坏的样本） ==');
{
  const at = (d, pages = goodPages()) => checkDraft(d, pages, TYPES);
  // 页码：第 2 张印的和第 1 张一样、比它小、跳了几页
  const p = goodPages();
  check('页码重复', rulesOf(at(goodDraft(), [p[0], { ...p[1], printedPage: 121 }])), 'page');
  check('页码倒了', at(goodDraft(), [p[0], { ...p[1], printedPage: 120 }])[0]?.id, 'page-order:2');
  const gap = at(goodDraft(), [p[0], { ...p[1], printedPage: 124 }]).find((i) => i.rule === 'page');
  check('缺页：说出缺第 122、123 页', `${gap?.scope}/${/122、123/.test(gap?.message)}`, 'job/true');
  // 题号：跳号、重号、第一题不是 1
  let d = goodDraft(); d.sections[0].questions.splice(4, 1);
  check('题号跳了（删掉第 5 题）', at(d).map((i) => i.id), [`no-gap:${d.sections[0].questions[4].id}`]);
  d = goodDraft(); d.sections[0].questions[5].no = 5;
  check('题号重了', at(d).filter((i) => i.rule === 'number').map((i) => i.id.split(':')[0]), ['no-dup', 'no-gap']);
  d = goodDraft(); d.sections[0].questions.shift();
  check('第一题不是 1', at(d).map((i) => i.id.split(':')[0]), ['no-start']);
  d = goodDraft(); d.sections[0].questions[2].no = null;
  check('没认出题号', at(d).map((i) => i.rule), ['number']);
  // 新的一部分接着上一部分往下编（同一套题跨了大题）不算错
  d = goodDraft(); const tail = d.sections[0].questions.splice(10);
  d.sections.push({ type: '选择填空', title: '续', passage: null, printedCount: null, questions: tail });
  check('接着上一部分往下编号：不报', at(d).length, 0);
  // 选项：少一个、重一个、不是 4 个
  d = goodDraft(); d.sections[0].questions[3].options.pop();
  check('少一个选项（缺 D）', /缺 D/.test(at(d)[0]?.message), true);
  d = goodDraft(); d.sections[0].questions[3].options[3] = 'C. again';
  check('选项字母重了（两个 C）', /C 重复/.test(at(d)[0]?.message), true);
  // 题量：书上写 20 题、认出 36 题
  d = goodDraft(); d.sections[0].printedCount = 20;
  check('题量对不上', at(d).map((i) => i.id), ['count:0']);
  // 段落填空：原文空号和题号对不上
  d = goodDraft(); d.sections[0].passage = 'He (1) went (2) to (3) the (99) shop.';
  check('原文有第 99 空、题里没有；第 4 题起在原文里找不到空', /第 99 空/.test(at(d).find((i) => i.rule === 'blanks')?.message), true);
  // 乱码、字数偏少、第二遍不一致、失败的页
  const pp = goodPages(); pp[1].text = pp[1].text.replace('\n', '\n□');
  check('乱码那一行', at(goodDraft(), pp).map((i) => i.id), ['garbled:2:1']);
  const p3 = [...goodPages(), { pageNo: 3, printedPage: 123, status: '已识别', text: 'x'.repeat(50), altDiffs: [] }, { pageNo: 4, printedPage: 124, status: '已识别', text: TRUTH_PAGES.find((q) => q.page === 124).text, altDiffs: [] }];
  check('字数不到别的页一半（不是最后一页）', at(goodDraft(), p3).filter((i) => i.rule === 'short').map((i) => i.pageNo), [3]);
  const pd = goodPages(); pd[0].altDiffs = [{ a: 'abc', b: 'abd' }];
  check('两次识别不一致', at(goodDraft(), pd).map((i) => i.id), ['alt:1:0']);
  const pf = [...goodPages(), { pageNo: 3, printedPage: null, status: '失败', text: null, error: 'ai_timeout' }];
  check('识别失败的页（红）', at(goodDraft(), pf).map((i) => `${i.id}/${i.level}`), ['page-failed:3/red']);
  d = goodDraft(); d.sections[0].questions[0].questionType = 'nope';
  check('题型这门课没有（红）', at(d).map((i) => `${i.rule}/${i.level}`), ['type/red']);
}

console.log('== 小工具 ==');
{
  check('选项字母：A. / (B) / C) / D、', optionLetters(['A. x', '(B) y', 'C) z', 'D、w']), ['A', 'B', 'C', 'D']);
  check('空号：(21)、__22__、23. ____', blankNumbers('a (21) b __22__ c 23. ____ d'), [21, 22, 23]);
  check('当场能查的：乱码、几乎没字', pageQuickIssues('ab\nc□d').map((i) => i.rule), ['garbled', 'empty']);
  check('当场能查的：比别的页少很多', pageQuickIssues('x'.repeat(40), { minChars: 100 }).map((i) => i.rule), ['short']);
  check('两次识别只挑不一样的行', altDiffs('一行\n二行\n三行', '一行\n二杭\n三行'), [{ a: '二行', b: '二杭' }]);
  check('读页码：【页码】121', takePrintedPage('【页码】121\n1. abc'), { printedPage: 121, body: '1. abc' });
  check('读页码：【页码】无', takePrintedPage('【页码】无\nabc').printedPage, null);
  check('没写页码那一行：正文原样', takePrintedPage('abc\ndef'), { printedPage: null, body: 'abc\ndef' });
}

console.log('== 拆题结果校验、分段、并回 ==');
{
  const ok = { sections: [{ type: '选择填空', title: 't', questions: [{ no: 1, questionType: 'single_choice', stem: 's', options: ['A. a', 'B. b', 'C. c', 'D. d'], pageNo: 3 }] }] };
  check('合格的收下', validateSplit(ok, { typeCodes: ['single_choice'], pageNos: [3] })[0].questions[0].no, 1);
  const err = (data) => { try { validateSplit(data, { typeCodes: ['single_choice'], pageNos: [3] }); return 'no error'; } catch (e) { return e.code; } };
  check('没有 sections → split_bad_shape', err({ foo: 1 }), 'split_bad_shape');
  check('题型不在本学科 → split_bad_type', err({ sections: [{ questions: [{ ...ok.sections[0].questions[0], questionType: 'x' }] }] }), 'split_bad_type');
  check('页号不在这一段 → split_bad_page', err({ sections: [{ questions: [{ ...ok.sections[0].questions[0], pageNo: 9 }] }] }), 'split_bad_page');
  check('选项不是字符串数组 → split_bad_shape', err({ sections: [{ questions: [{ ...ok.sections[0].questions[0], options: [1, 2] }] }] }), 'split_bad_shape');
  const a = [{ type: 'A', title: '一', passage: 'p1', questions: [{ no: 1 }] }];
  const b = [{ type: 'A', title: '一', passage: 'p2', continues: true, questions: [{ no: 2 }] }, { type: 'B', title: '二', questions: [{ no: 1 }] }];
  const m = mergeChunks([a, b]);
  check('标了 continues 的并回上一部分（题、原文都接上）', `${m.length}/${m[0].questions.map((q) => q.no)}/${m[0].passage}`, '2/1,2/p1\np2');
  const pages = Array.from({ length: 10 }, (_, i) => ({ pageNo: i + 1, text: 'x'.repeat(1000) }));
  check(`每段不超过 ${SPLIT_PAGES_PER_CALL} 页`, chunkPages(pages).map((c) => c.length), [4, 4, 2]);
  check('一页太长就单独一段', chunkPages([{ text: 'x'.repeat(8000) }, { text: 'x'.repeat(8000) }]).length, 2);
}

console.log('== 草稿拼成题库文件 ==');
{
  const job = { title: 'T', draft: { sections: [{ type: '选择填空', title: '选择', passage: null, questions: [
    { no: 1, questionType: 'single_choice', stem: 'a', options: ['A. x', 'B. y', 'C. z', 'D. w'] },
    { no: 2, questionType: 'spell_word', stem: 'b', options: null },
    { no: 3, questionType: 'pt', stem: 'c', options: null }] }, { type: '空的', questions: [] }] } };
  const f = draftToGroupFile(job, [{ code: 'single_choice', widget: 'choice' }, { code: 'spell_word', widget: 'text', strategy: 'EXACT' }, { code: 'pt', widget: 'text', strategy: 'AI_SCORE_POINTS' }]);
  check('没有题的部分不进题库文件', f.sections.length, 1);
  check('答案状态缺答案（等出答案那一步）', f.answerState, '缺答案');
  check('选择题、按采分点批的不带空；拼写给一个空', f.sections[0].questions.map((q) => (q.items || []).length), [0, 1, 0]);
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
