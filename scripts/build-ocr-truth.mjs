#!/usr/bin/env node
// 识别实测（改进阶段 2 第二期）的"标准答案"：把公共英语的人工转写稿按**原书页码**整理成一份数据，
// 写进 worker/src/ocr-bench/truth-data.js，后台「识别实测」页按你选的页码取（随页面打包，不另开接口）。
//
//   node scripts/build-ocr-truth.mjs          生成
//   node scripts/build-ocr-truth.mjs --check  只比对（生成的和盘上的不一样就退出 1；node 单测调它）
//
// 两类页：
//   - 选择题强化训练（一）（二）：每页是哪几道题，是 2026-11-09 对着扫描件逐页读出来的（下面 MC_PAGES），
//     标准答案精确到这一页，算得出题目完整率；
//   - 教学重点（按课，一课占两页）、考试样卷 2（7 页）：转写稿没按页切，标准答案是整课 / 整卷，
//     比对时在里面找和这一页最像的那一段（半全局比对），只算字符准确率。转写稿不含原书的栏目标题
//     （"I. Words"之类），这两类页的准确率会略偏低——主要拿来比模型之间谁高谁低。
// 原书第 132 页（说明）、第 154–155 页（样卷 1 残页）没有转写稿，传了只记耗时和花费。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'data/subjects/pubeng/source');
const out = path.join(root, 'worker/src/ocr-bench/truth-data.js');

// 原书页码 → [起题号, 止题号]（对着扫描件读的每页首尾题号）
const MC_PAGES = {
  'mc-set1.txt': [
    [121, 1, 17], [122, 18, 36], [123, 37, 56], [124, 57, 75], [125, 76, 94], [126, 95, 113],
    [127, 114, 132], [128, 133, 149], [129, 150, 168], [130, 169, 185], [131, 186, 200],
  ],
  'mc-set2.txt': [
    [163, 1, 14], [164, 15, 33], [165, 34, 51], [166, 52, 71], [167, 72, 88], [168, 89, 105],
    [169, 106, 120], [170, 121, 136], [171, 137, 152], [172, 153, 168], [173, 169, 185], [174, 186, 200],
  ],
};
const MC_LABEL = { 'mc-set1.txt': '选择题强化训练（一）', 'mc-set2.txt': '选择题强化训练（二）' };

function readMc(file) {
  const rows = new Map();
  for (const line of fs.readFileSync(path.join(src, file), 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('|');
    if (parts.length !== 6) throw new Error(`${file}：这一行不是 题号|题干|A|B|C|D：${line.slice(0, 60)}`);
    rows.set(Number(parts[0]), parts.slice(1));
  }
  return rows;
}
const mcText = (no, [stem, a, b, c, d]) => `${no}. ${stem}\nA) ${a}  B) ${b}\nC) ${c}  D) ${d}`;
const optText = (items) => items.map((x, i) => `${'ABCD'[i]}) ${x}`).join('  ');

const pages = [];
const docs = {};

for (const [file, ranges] of Object.entries(MC_PAGES)) {
  const rows = readMc(file);
  let expect = 1;
  for (const [page, from, to] of ranges) {
    if (from !== expect) throw new Error(`${file}：第 ${page} 页从第 ${from} 题起，上一页止于第 ${expect - 1} 题，接不上`);
    expect = to + 1;
    const nos = [];
    const lines = [];
    for (let n = from; n <= to; n++) {
      const r = rows.get(n);
      if (!r) throw new Error(`${file} 里没有第 ${n} 题`);
      nos.push(n);
      lines.push(mcText(n, r));
    }
    pages.push({ page, kind: 'mc', label: `${MC_LABEL[file]} 第 ${from}–${to} 题`, text: lines.join('\n'), questions: nos });
  }
  if (expect - 1 !== rows.size) throw new Error(`${file}：按页切完是 ${expect - 1} 题，文件里有 ${rows.size} 题`);
}

// 教学重点：一课一段，课里写着占哪两页
const units = JSON.parse(fs.readFileSync(path.join(src, 'units.json'), 'utf8')).units;
for (const u of units) {
  const id = `unit-${u.id}`;
  const parts = [`Unit ${u.unit} (Book ${u.book})`, u.title];
  parts.push(...u.words.map(([w, m]) => `${w} ${m}`));
  parts.push(...u.phrases.map(([p, m]) => `${p} ${m}`));
  u.sentences.forEach(([zh, en], i) => parts.push(`${i + 1}. ${zh}`, en));
  for (const p of u.paragraphs) parts.push(p.en, p.zh);
  docs[id] = parts.join('\n');
  const [a, b] = String(u.pages).split(/[–-]/).map(Number);
  for (let pg = a; pg <= (b || a); pg++) {
    pages.push({ page: pg, kind: 'doc', label: `教学重点 第${u.book === 1 ? '一' : '二'}册第 ${u.unit} 课（整课比对）`, doc: id });
  }
}

// 考试样卷 2：整卷一段（原书 156–162 页）
{
  const t = JSON.parse(fs.readFileSync(path.join(src, 'sample-test2.json'), 'utf8'));
  const parts = ['Sample Test 2 (Stage Four)'];
  parts.push(t.spelling.directions, ...t.spelling.items.map((x, i) => `${i + 1}. ${x}`));
  parts.push(t.phrases.directions, ...t.phrases.items.map((x, i) => `${i + 1}. ${x}`));
  parts.push(t.choices.directions, ...t.choices.items.map(([s, ...o], i) => `${i + 1}. ${s}\n${optText(o)}`));
  parts.push(t.passageFill.directions, t.passageFill.wordBox.join(' '), t.passageFill.passage);
  parts.push(t.reading.directions);
  for (const p of t.reading.passages) {
    parts.push(p.text, ...p.questions.map(([s, ...o], i) => `${i + 1}. ${s}\n${optText(o)}`));
  }
  parts.push(t.sentences.directions, ...t.sentences.items.map((x, i) => `${i + 1}. ${x}`));
  parts.push(t.paragraph.directions, t.paragraph.text);
  docs['test2'] = parts.join('\n');
  for (let pg = 156; pg <= 162; pg++) pages.push({ page: pg, kind: 'doc', label: '第四段考试样卷 2（整卷比对）', doc: 'test2' });
}

pages.sort((x, y) => x.page - y.page);
const seen = new Set();
for (const p of pages) {
  if (seen.has(p.page)) throw new Error(`原书第 ${p.page} 页出现了两次`);
  seen.add(p.page);
}

const body = `// 由 scripts/build-ocr-truth.mjs 从 data/subjects/pubeng/source/ 生成，不要手改。
// 识别实测的标准答案：原书页码 → 这一页该识别出什么。说明见生成器顶部。
export const SOURCE = '公共英语课程 教学重点与考试样卷（扫描件）';
export const UNAVAILABLE = { 132: '第四段教学说明，没有转写稿', 154: '考试样卷 1 残页，没有转写稿', 155: '考试样卷 1 残页，没有转写稿' };
export const DOCS = ${JSON.stringify(docs, null, 1)};
export const TRUTH_PAGES = ${JSON.stringify(pages, null, 1)};
`;

if (process.argv.includes('--check')) {
  const now = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '';
  if (now !== body) {
    console.error(`worker/src/ocr-bench/truth-data.js 和转写稿对不上，重新跑 node scripts/build-ocr-truth.mjs`);
    process.exit(1);
  }
  console.log(`识别实测标准答案和转写稿一致：${pages.length} 页`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, body);
  console.log(`写好了 ${path.relative(root, out)}：${pages.length} 页（选择题 ${pages.filter((p) => p.kind === 'mc').length} 页），${Object.keys(docs).length} 段整段比对`);
}
