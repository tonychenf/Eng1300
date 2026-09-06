#!/usr/bin/env node
// 把 data/exams/*.json 与 data/knowledge-points.json 转成可直接喂给 D1 的 SQL。
// 按试卷分文件输出，避免单个 SQL 文件过大导致 d1 execute 失败。
//
// 用法: node scripts/build-seed-sql.mjs [输出目录]
//   默认输出到 worker/seed/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || path.join(root, 'worker', 'seed');
const examDir = path.join(root, 'data', 'exams');

// 课程合并：00015《英语(二)》在 2024 年 10 月起改用新代码 13000《英语(专升本)》，
// 是同一门课的前后两个编号。JSON 里保留每份卷子印的原始代码，入库时统一归到 13000，
// 这样组卷和练习抽题看到的是一个完整题库。
const COURSE_ALIAS = { '00015': '13000' };

// 解析存疑记录里点名的题号，这些题不参与组卷与练习。
// 记录是整卷一条条自由文本，但基本都会写明"第N题"或"第N-M题"；把这些题
// 标成"存疑"，抽题只认"已发布"，就自动跳过了。整篇少一题也凑不满模板题量，
// 所配的整个部分会一并落选，不会把原文拆散。
function flaggedOrders(exam) {
  const flagged = new Set();
  for (const note of exam.parsingNotes || []) {
    for (const m of note.matchAll(/第\s*(\d+)\s*[-–—~至]\s*(\d+)\s*题/g)) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) flagged.add(i);
    }
    for (const m of note.matchAll(/第\s*(\d+)\s*题/g)) flagged.add(Number(m[1]));
  }
  return flagged;
}
const courseOf = (code) => COURSE_ALIAS[code] || code;

// SQL 字符串字面量转义：单引号翻倍，NULL 单独处理
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const n = (v) => (v === null || v === undefined ? 'NULL' : Number(v));

fs.mkdirSync(outDir, { recursive: true });
for (const f of fs.readdirSync(outDir)) {
  if (f.endsWith('.sql')) fs.unlinkSync(path.join(outDir, f));
}

// ---- 考点标签库 ----
const kps = JSON.parse(fs.readFileSync(path.join(root, 'data', 'knowledge-points.json'), 'utf8'));
const kpByName = new Map(kps.map((k) => [k.name, k.tagId]));
const kpLines = kps.map(
  (k) => `INSERT OR IGNORE INTO knowledge_points (tag_id, name) VALUES (${q(k.tagId)}, ${q(k.name)});`
);
fs.writeFileSync(path.join(outDir, '000-knowledge-points.sql'), kpLines.join('\n') + '\n');

// ---- 各套试卷 ----
const files = fs.readdirSync(examDir).filter((f) => f.endsWith('.json')).sort();
let totalQ = 0;
let totalFlagged = 0;
let unknownTags = new Set();

for (const file of files) {
  const d = JSON.parse(fs.readFileSync(path.join(examDir, file), 'utf8'));
  const courseCode = courseOf(d.courseCode);
  const flagged = flaggedOrders(d);
  const lines = [];

  // 幂等：重复导入时先清掉这套卷的旧数据，避免主键冲突或残留
  lines.push(
    `DELETE FROM question_knowledge_points WHERE question_id IN (SELECT question_id FROM questions WHERE exam_id = ${q(d.examId)});`,
    `DELETE FROM questions WHERE exam_id = ${q(d.examId)};`,
    `DELETE FROM sections WHERE exam_id = ${q(d.examId)};`,
    `DELETE FROM exam_parsing_notes WHERE exam_id = ${q(d.examId)};`,
    `DELETE FROM exams WHERE exam_id = ${q(d.examId)};`
  );

  lines.push(
    `INSERT INTO exams (exam_id, course_code, title, year, month, source_file, status) VALUES (` +
      `${q(d.examId)}, ${q(courseCode)}, ${q(d.title)}, ${n(d.year)}, ${n(d.month)}, ` +
      `${q(d.sourceFile)}, ${q(d.status || '待校对')});`
  );

  for (const s of d.sections) {
    lines.push(
      `INSERT INTO sections (section_id, exam_id, type, ord, passage_title, passage_text, ` +
        `writing_prompt, score_per_question, total_score) VALUES (` +
        `${q(s.sectionId)}, ${q(d.examId)}, ${q(s.type)}, ${n(s.order)}, ${q(s.passageTitle)}, ` +
        `${q(s.passageText)}, ${q(s.writingPrompt)}, ${n(s.scorePerQuestion)}, ${n(s.totalScore)});`
    );

    for (const qu of s.questions) {
      totalQ++;
      if (flagged.has(qu.order)) totalFlagged++;
      lines.push(
        `INSERT INTO questions (question_id, section_id, exam_id, course_code, section_type, ord, ` +
          `question_type, stem, options, answer, answer_explanation, difficulty_tag, status) VALUES (` +
          `${q(qu.questionId)}, ${q(s.sectionId)}, ${q(d.examId)}, ${q(courseCode)}, ${q(s.type)}, ` +
          `${n(qu.order)}, ${q(qu.questionType)}, ${q(qu.stem)}, ` +
          `${qu.options ? q(JSON.stringify(qu.options)) : 'NULL'}, ${q(qu.answer)}, ` +
          `${q(qu.answerExplanation)}, ${q(qu.difficultyTag)}, ` +
          `${flagged.has(qu.order) ? "'存疑'" : "'草稿'"});`
      );
      for (const tag of qu.knowledgePoints || []) {
        const tagId = kpByName.get(tag);
        if (!tagId) { unknownTags.add(tag); continue; }
        lines.push(
          `INSERT OR IGNORE INTO question_knowledge_points (question_id, tag_id) VALUES (${q(qu.questionId)}, ${q(tagId)});`
        );
      }
    }
  }

  for (const note of d.parsingNotes || []) {
    lines.push(`INSERT INTO exam_parsing_notes (exam_id, note) VALUES (${q(d.examId)}, ${q(note)});`);
  }

  const outName = `${String(files.indexOf(file) + 1).padStart(3, '0')}-${d.examId}.sql`;
  fs.writeFileSync(path.join(outDir, outName), lines.join('\n') + '\n');
}

if (unknownTags.size) {
  console.error(`错误：以下考点标签不在 knowledge-points.json 中：${[...unknownTags].join(', ')}`);
  process.exit(1);
}

console.log(`生成完成：${files.length} 套试卷，${totalQ} 道题，${kps.length} 个考点标签 -> ${outDir}`);
console.log(`其中 ${totalFlagged} 道被解析存疑记录点名，标为"存疑"，不参与组卷与练习。`);
