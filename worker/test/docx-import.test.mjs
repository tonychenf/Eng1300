// 生化 docx 导入器的验收（§14.3 的 B1～B4）。纯 node，不起服务。
//
// 样本是仓库里那份真实的 `第01章-蛋白质的化学.docx`，不是构造的最小 docx。
// 理由：这个导入器唯一的职责就是读懂**这一种**排版，构造样本只能证明代码跑得通。
//
// 最后一段是**交叉核对**：把导入器的产出和人工整理的 groups/biochem-ch01.json
// 逐题比题干与选项。两边不同源——一边是程序从 docx 解出来的，一边是人对着
// 原件敲的——所以对得上才有意义。这一段要是退化成"拿导入器的产出去对导入器的
// 产出"，它就什么都证明不了了。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readZip } from '../../scripts/import/lib/zip.mjs';
import { parseParagraphs, parseNumbering, applyNumbering } from '../../scripts/import/lib/ooxml.mjs';
import { importDocx } from '../../scripts/import/docx-structured.mjs';
import { resolvePipeline } from '../../scripts/import/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const subjectDir = path.join(root, 'data', 'subjects', 'biochem');
const docxPath = path.join(subjectDir, 'source', '第01章-蛋白质的化学.docx');

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};

// 参数从注册表里取，不在这里另写一份：写死的话它和 import-subject.mjs 会各跑各的，
// 而 courseCode 对不上的后果是题挂到一个不存在的课程上——D1 不强制外键，不报错。
const { cfg } = resolvePipeline('biochem');
const g0 = cfg.groups[0];
const buf = fs.readFileSync(docxPath);
const { group, stats } = importDocx(buf, {
  subjectCode: 'biochem', courseCode: cfg.courseCode,
  groupId: g0.groupId, chapterNo: g0.chapterNo, label: g0.label,
});
const curated = JSON.parse(
  fs.readFileSync(path.join(subjectDir, 'groups', 'biochem-ch01.json'), 'utf8'));

const sectionOf = (g, type) => g.sections.find((s) => s.type === type);
const allQ = (g) => g.sections.flatMap((s) => s.questions);

console.log('== B1：题量、空数、采分点 ==');
check('共 34 道题', stats.questions, 34);
check('填空题 12 道', sectionOf(group, '填空题').questions.length, 12);
check('选择题 13 道', sectionOf(group, '选择题').questions.length, 13);
check('名词解释 7 道', sectionOf(group, '名词解释').questions.length, 7);
check('问答题 2 道', sectionOf(group, '问答题').questions.length, 2);
check('50 个空', stats.blanks, 50);
// 采分点是人工/AI 补的，docx 里没有，所以这一条断在人工整理的那份上。
// 放在这里而不是另开一个文件，是因为 B1 那条验收标准把它们写在一起
// （"34 道题 / 50 个空 / 32 个采分点"），拆开看不出这个数是不是还成立。
const curatedPoints = allQ(curated)
  .flatMap((q) => q.items || []).filter((it) => it.kind === 'SCORE_POINT').length;
check('人工整理的那份有 32 个采分点', curatedPoints, 32);
check('导入器自己不编采分点', allQ(group).flatMap((q) => q.items || [])
  .filter((it) => it.kind === 'SCORE_POINT').length, 0);

console.log('== B2：Word 自动编号还原 ==');
// 这一段刻意绕开 importDocx，直接看段落层：**题号和选项字母在 XML 的文本里
// 根本不存在**，全靠 numbering.xml 还原。断在 importDocx 的产出上测不到这件事
// ——切题的正则找不到题号时会把整段并进上一题，题数照样可能凑巧对。
const files = readZip(buf);
const dec = (name) => new TextDecoder().decode(files.get(name));
const rawParas = parseParagraphs(dec('word/document.xml'));
const numbered = applyNumbering(
  parseParagraphs(dec('word/document.xml')), parseNumbering(dec('word/numbering.xml')));
const sliceOf = (paras, from, to) => {
  const i = paras.findIndex((p) => (p.text || '').trim() === from);
  const j = paras.findIndex((p, k) => k > i && (p.text || '').trim() === to);
  return paras.slice(i + 1, j);
};
const rawChoice = sliceOf(rawParas, '选择题', '名词解释');
const numChoice = sliceOf(numbered, '选择题', '名词解释');
const startsWithNum = (p) => /^\s*\d+\s*[.．、]/.test(`${p.number || ''}${p.text || ''}`);
const startsWithA = (p) => /^\s*A\s*[.．、]/.test(`${p.number || ''}${p.text || ''}`);
const textStartsWithNum = (p) => /^\s*\d+\s*[.．、]/.test(p.text || '');
check('还原前：选择题段落的文本里一个题号都没有', rawChoice.filter(textStartsWithNum).length, 0);
check('还原前：选择题段落的文本里只有 1 个 A 选项字母',
  rawChoice.filter((p) => /^\s*A\s*[.．、]/.test(p.text || '')).length, 1);
check('还原后：13 道选择题都有题号', numChoice.filter(startsWithNum).length, 13);
check('还原后：13 处 A 选项字母（12 处是还原出来的）', numChoice.filter(startsWithA).length, 13);
check('还原出来的编号连续到 13', numChoice.filter(startsWithNum)
  .map((p) => parseInt(p.number, 10)).join(','), Array.from({ length: 13 }, (_, i) => i + 1).join(','));

console.log('== B3：跨段落题干合并 ==');
const q7 = sectionOf(group, '填空题').questions.find((q) => q.order === 7);
check('第 7 题存在', Boolean(q7), true);
// 原件里 "……蛋白质的最大吸收峰波长是" 和 "nm。" 是两个段落。
// 不合并的话第 7 题会缺最后一个空，而题数、空数都还是对的——只有这条断得到。
check('第 7 题题干以「波长是＿nm。」收尾', (q7?.stem || '').endsWith('波长是＿nm。'), true);
check('第 7 题共 4 个空', (q7?.items || []).length, 4);
check('「nm。」没有变成独立的一道题',
  sectionOf(group, '填空题').questions.some((q) => (q.stem || '').trim().startsWith('nm')), false);

console.log('== B4：原题有误的订正留痕 ==');
const bad = group.parsingNotes.filter((n) => n.kind === '原题有误');
check('记了一条原题有误', bad.length, 1);
check('点名的是内容组内第 21 题', JSON.stringify(bad[0]?.questionOrders), '[21]');
check('记的是原始资料错，不是解析存疑', bad[0]?.kind, '原题有误');
check('留下了订正前原文', (bad[0]?.correctedFrom || '').includes('D.缔合现象'), true);
check('留下了订正后', (bad[0]?.correctedTo || '').includes('B.缔合现象'), true);
check('订正只动标号，选项文字一个字不改',
  (bad[0]?.correctedFrom || '').replace(/[A-E]\./g, ''),
  (bad[0]?.correctedTo || '').replace(/[A-E]\./g, ''));
check('订正人留了痕', Boolean(bad[0]?.correctedBy), true);
const q21 = allQ(group).find((q) => q.order === 21);
check('第 21 题的选项已按 A/B/C/D 排好',
  (q21?.options || []).map((o) => o.slice(0, 1)).join(''), 'ABCD');
check('第 21 题带订正说明', Boolean(q21?.correctionApplied), true);
// 已经修好的题不该被永久扣下（见需求文档 N6 实现说明第 4 条）。
check('订正过的题不是存疑', q21?.status, '草稿');

console.log('== 交叉核对：导入器产出 vs 人工整理的那份 ==');
// 先对身份：课程码、内容组 id、排序键、显示名。这四个对不上的话，
// 下面逐题比出来的"一致"没有意义——比的是两份不同内容组的题。
check('课程码一致', group.courseCode, curated.courseCode);
check('内容组 id 一致', group.groupId, curated.groupId);
check('排序键一致', group.orderKey, curated.orderKey);
check('显示名一致', group.label, curated.label);
const curatedById = new Map(allQ(curated).map((q) => [q.questionId, q]));
let missing = 0, stemDiff = 0, optDiff = 0;
const firstDiff = [];
for (const q of allQ(group)) {
  const c = curatedById.get(q.questionId);
  if (!c) { missing++; continue; }
  if (c.stem !== q.stem) {
    stemDiff++;
    if (firstDiff.length < 3) firstDiff.push(`第${q.order}题题干\n    导入：${q.stem}\n    人工：${c.stem}`);
  }
  const a = JSON.stringify(q.options || null), b = JSON.stringify(c.options || null);
  if (a !== b) {
    optDiff++;
    if (firstDiff.length < 3) firstDiff.push(`第${q.order}题选项\n    导入：${a}\n    人工：${b}`);
  }
}
if (firstDiff.length) console.log(`  （前几处分歧）\n  - ${firstDiff.join('\n  - ')}`);
check('两边题号集合一致', missing, 0);
check('34 道题的题干逐字一致', stemDiff, 0);
check('34 道题的选项逐字一致', optDiff, 0);
// 上面三条要是因为"两边都空"而通过，就什么都没证明。
check('确实比了 34 道题', allQ(group).length, 34);
// 名词解释的题干就是一个词（"肽键"），所以只能断"非空"，不能断长度。
check('没有一道题的题干是空的', allQ(group).every((q) => (q.stem || '').trim().length > 0), true);
check('题干总长度不是个位数', allQ(group).reduce((n, q) => n + (q.stem || '').length, 0) > 1000, true);

console.log('== 导入器不越界 ==');
// 导入器只出题面。它要是顺手编一个答案出来，那答案会带着"看起来很像样"的
// 外壳进到补答案工作流里，而没有人会再去核它。
check('没有一道题带 answer', allQ(group).some((q) => q.answer), false);
check('填空的空全是空答案',
  allQ(group).flatMap((q) => q.items || []).some((it) => it.answer), false);
check('全部落在缺答案', new Set(allQ(group).map((q) => q.answerState)).size, 1);
check('缺答案是那一格', allQ(group)[0].answerState, '缺答案');
check('组级也声明了缺答案', group.answerState, '缺答案');

console.log(`== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
