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
let unknownTags = new Set();

for (const file of files) {
  const d = JSON.parse(fs.readFileSync(path.join(examDir, file), 'utf8'));
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
      `${q(d.examId)}, ${q(d.courseCode)}, ${q(d.title)}, ${n(d.year)}, ${n(d.month)}, ` +
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
      lines.push(
        `INSERT INTO questions (question_id, section_id, exam_id, course_code, section_type, ord, ` +
          `question_type, stem, options, answer, answer_explanation, difficulty_tag, status) VALUES (` +
          `${q(qu.questionId)}, ${q(s.sectionId)}, ${q(d.examId)}, ${q(d.courseCode)}, ${q(s.type)}, ` +
          `${n(qu.order)}, ${q(qu.questionType)}, ${q(qu.stem)}, ` +
          `${qu.options ? q(JSON.stringify(qu.options)) : 'NULL'}, ${q(qu.answer)}, ` +
          `${q(qu.answerExplanation)}, ${q(qu.difficultyTag)}, '草稿');`
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
