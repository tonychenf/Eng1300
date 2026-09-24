#!/usr/bin/env node
// 把一个学科的原始资料导成题库 JSON（需求文档 §6.4.3）。
//
//   node scripts/import-subject.mjs biochem [--out 目录]
//
// **不会覆盖 data/subjects/<code>/groups/**。那里是人工整理过、带答案的题库；
// 导入器只产出题面，答案要走补答案工作流（§6.4.10）。默认写到 imported/ 下，
// 由人去比对、合并。直接覆盖的话，一次手滑就把几十道题的答案抹了。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePipeline } from './import/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const subjectCode = args.find((a) => !a.startsWith('--'));
if (!subjectCode) {
  console.error('用法：node scripts/import-subject.mjs <学科码> [--out 目录]');
  process.exit(2);
}
const outFlag = args.indexOf('--out');
const subjectDir = path.join(root, 'data', 'subjects', subjectCode);
const outDir = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : path.join(subjectDir, 'imported');

let cfg;
let pipeline;
try {
  ({ cfg, pipeline } = resolvePipeline(subjectCode));
} catch (e) {
  console.error(`错误：${e.message}`);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
let total = 0;
let blanks = 0;
for (const g of cfg.groups) {
  const src = path.join(subjectDir, g.source);
  if (!fs.existsSync(src)) {
    console.error(`错误：找不到原始资料 ${src}`);
    process.exit(1);
  }
  const { group, stats } = pipeline.run(fs.readFileSync(src), {
    subjectCode, courseCode: cfg.courseCode,
    groupId: g.groupId, chapterNo: g.chapterNo, label: g.label,
  });
  fs.writeFileSync(path.join(outDir, `${g.groupId}.json`),
    `${JSON.stringify(group, null, 2)}\n`);
  total += stats.questions;
  blanks += stats.blanks;
  const per = stats.perSection.map((s) => `${s.type} ${s.count}`).join('，');
  console.log(`${g.groupId}：${stats.questions} 题（${per}），${stats.blanks} 个空 -> ${outDir}`);
  for (const n of group.parsingNotes) console.log(`  [${n.kind}] ${n.note}`);
}
console.log(`导入完成：${cfg.groups.length} 个内容组，${total} 道题，${blanks} 个空。` +
  '题面已出，答案待补（§6.4.10）。');
