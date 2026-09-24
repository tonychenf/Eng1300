#!/usr/bin/env node
// 把 data/exams/*.json 与 data/knowledge-points.json 转成可直接喂给 D1 的 SQL。
// 按试卷分文件输出，避免单个 SQL 文件过大导致 d1 execute 失败。
//
// 用法: node scripts/build-seed-sql.mjs [输出目录]
//   默认输出到 worker/seed/

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// 契约校验与 worker 共用同一份实现：种子这边认得的写法发布那边不认，
// 表现是题入了库、发布时被拒，而报错指向一个看起来毫无关系的地方。
import { validateAssets } from '../worker/src/lib/stem-assets.js';
import { ANSWER_STATES, ANSWER_SOURCES, ANSWER_CONFIRMED } from '../worker/src/lib/pickable.js';
import { ITEM_KINDS } from '../worker/src/lib/question-items.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = process.argv[2] || path.join(root, 'worker', 'seed');
// N4：英语的数据搬进了 data/subjects/english/，和生化同一种布局——
// 学科是顶层分区，英语不再是"默认的那个"，只是第一个学科。
// SEED_SUBJECT_DIR 是给测试用的：契约校验（§6.4.6 G2、§6.4.9）要能拿一份
// **故意写坏的**构造数据跑一遍，看它是不是真的拒了、真的把题号打出来了。
// 拿真实题库测不到——真实题库是对的，跑一百遍也只能证明"没报错"。
const subjectDir = process.env.SEED_SUBJECT_DIR
  ? path.resolve(process.env.SEED_SUBJECT_DIR)
  : path.join(root, 'data', 'subjects', 'english');
const examDir = path.join(subjectDir, 'groups');

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
    const n = normalizeNote(note);
    // 原题有误 + 已留下订正前后（§6.4.10）：资料错了，我们改了，并且说得清改了什么。
    // 这种题**不扣**——扣下它等于把一道已经修好的题永久踢出题库。
    // 人工仍然要过一遍：整卷发布那道关要求所有记录都标为已处理，这道关还在。
    if (n.kind === '原题有误' && n.correctedFrom && n.correctedTo) continue;
    // 结构化记录直接点名题号，**绝不从正文里猜**：正文里的"第9题"说的是原卷、
    // 按题型分组之后的题号，与本文件的 order 对不上——生化选择题第 9 题是本文件
    // 第 21 题。猜错的后果是扣下一道好题、放过一道坏题，两边都不报错。
    // 从正文里认题号只对蓝本那 20 份自由文本记录成立，所以按记录的**写法**分流，
    // 不按学科分流。
    if (!n.fromText) {
      for (const o of n.questionOrders || []) flagged.add(Number(o));
      continue;
    }
    for (const m of n.note.matchAll(/第\s*(\d+)\s*[-–—~至]\s*(\d+)\s*题/g)) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) flagged.add(i);
    }
    for (const m of n.note.matchAll(/第\s*(\d+)\s*题/g)) flagged.add(Number(m[1]));
  }
  return flagged;
}

// 解析记录有两种写法：蓝本是一条自由文本，导入器产出的是带 kind 与订正留痕的对象
// （§6.4.10）。两种都要认，因为英语那 20 份是人工整理的纯文本。
function normalizeNote(note) {
  if (typeof note === 'string') return { kind: '解析存疑', note, fromText: true };
  if (!note || typeof note.note !== 'string') {
    throw new Error(`解析记录的形状不对：${JSON.stringify(note)?.slice(0, 120)}`);
  }
  return {
    kind: note.kind || '解析存疑',
    note: note.note,
    fromText: false,
    questionOrders: Array.isArray(note.questionOrders) && note.questionOrders.length
      ? note.questionOrders : null,
    correctedFrom: note.correctedFrom ?? null,
    correctedTo: note.correctedTo ?? null,
    correctedBy: note.correctedBy ?? null,
  };
}
const courseOf = (code) => COURSE_ALIAS[code] || code;

// SQL 字符串字面量转义：单引号翻倍，NULL 单独处理
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const n = (v) => {
  if (v === null || v === undefined) return 'NULL';
  const x = Number(v);
  // NaN / Infinity 写进 SQL 是一句语法错误，而报错要等到 d1 import 那一步，
  // 拿到的信息是"导入 003-xxx.sql 失败"——离真正的原因（某处算术算歪了）隔着三层。
  // 在这里拦住，把算歪的那个值打出来。
  if (!Number.isFinite(x)) {
    throw new Error(`要写进 SQL 的数值不是有限数：${JSON.stringify(v)}（算出来是 ${x}）`);
  }
  return x;
};

fs.mkdirSync(outDir, { recursive: true });

// ---- 考点标签库 ----
// 考点文件包成了 { subjectCode, note, points: [...] }，与生化同形；
// 读不到 points 就抛错，不要回落成"当它是个数组"——那会静默生成一份空考点库。
const kpFile = JSON.parse(fs.readFileSync(path.join(subjectDir, 'knowledge-points.json'), 'utf8'));
if (!Array.isArray(kpFile.points)) {
  throw new Error(`考点文件的形状不对：顶层键是 ${Object.keys(kpFile).join(',')}，应当有 points 数组`);
}
const kps = kpFile.points;
const subjectCode = kpFile.subjectCode || path.basename(subjectDir);

// 考点可以有层级（生化是 章 → 知识点 两层，英语是单层，§6.4.1）。
// 题目里写的标签有两种：单层学科写裸名（"阅读理解"），分层学科写全路径
// （"蛋白质化学/肽与肽键"）。两种都要认。
//
// 裸名在分层学科里会撞（第 2 章也可能有"结构"），所以**撞了就不给解析**：
// 挑一个是错的——挂错考点不报错，表现是练习按考点筛选时抽到别的章的题。
const kpById = new Map(kps.map((k) => [k.tagId, k]));
const pathOf = (k) => {
  const parts = [];
  for (let cur = k, depth = 0; cur; cur = cur.parentTagId ? kpById.get(cur.parentTagId) : null) {
    parts.unshift(cur.name);
    if (++depth > 10) throw new Error(`考点 ${k.tagId} 的父链成环或过深`);
  }
  return parts.join('/');
};
const kpByName = new Map();
const ambiguous = new Set();
for (const k of kps) {
  kpByName.set(pathOf(k), k.tagId);
  if (kpByName.has(k.name) && kpByName.get(k.name) !== k.tagId) ambiguous.add(k.name);
  else if (!ambiguous.has(k.name)) kpByName.set(k.name, k.tagId);
}
for (const name of ambiguous) kpByName.delete(name);
// 父考点要排在子考点前面：kpLines 用 INSERT OR IGNORE，父行还没进库时
// parent_tag_id 指向一个不存在的 tag_id，而 D1 默认不强制外键，不会报错。
const seen = new Set();
for (const k of kps) {
  if (k.parentTagId && !seen.has(k.parentTagId)) {
    throw new Error(`考点文件顺序不对：${k.tagId} 的父 ${k.parentTagId} 排在它后面`);
  }
  seen.add(k.tagId);
}
// N3：考点带学科。原来 name 是全局 UNIQUE，多学科之后必撞；改成
// (subject_id, name) 唯一之后，subject_id 留空的话 SQLite 认为 NULL 各不相同，
// 唯一约束等于没有——所以这里必须现取，不能省。
const kpLines = kps.map(
  (k, i) => `INSERT OR IGNORE INTO knowledge_points (tag_id, name, subject_id, parent_tag_id, sort_order) VALUES (` +
    `${q(k.tagId)}, ${q(k.name)}, (SELECT subject_id FROM subjects WHERE code = ${q(subjectCode)}), ` +
    `${q(k.parentTagId)}, ${n(k.sortOrder ?? i)});`
);
// 把内容指纹作为最后一条语句写进种子文件本身。
//
// 起因：原先是"导入文件"和"记 seed_state 指纹"两次独立的 D1 调用。第一次
// 成功、第二次因为写入额度耗尽而失败，结果是数据进去了、指纹没记上，下一次
// 部署又原样重导一遍，再次在同一处失败——每跑一次白烧约 578 行额度，永远
// 走不出来。写进同一个文件后，d1 execute --file 是一次导入，指纹和数据同生
// 共死，导入成功就一定记上了。
function writeSeedFile(dir, name, lines) {
  const body = lines.join('\n') + '\n';
  const sha = crypto.createHash('sha256').update(body).digest('hex');
  const stamp =
    `INSERT INTO seed_state (name, sha, applied_at) VALUES ('${name}', '${sha}', datetime('now'))\n` +
    `  ON CONFLICT(name) DO UPDATE SET sha = excluded.sha, applied_at = excluded.applied_at;\n`;
  fs.writeFileSync(path.join(dir, name), body + stamp);
}

// 先攒着，等所有校验都过了再一起落盘。
//
// 起因：契约校验放在最后，而 SQL 是逐套写出去的，于是"生成失败"之后
// worker/seed/ 里已经躺着几个新文件了。流水线导题库那一步是 `for f in seed/*.sql`，
// 它不知道生成器刚才失败过——被拒的题照样进库。
// **要么全写，要么一个都不写。**
const pending = [['000-knowledge-points.sql', kpLines]];

// ---- 各套试卷 ----
const files = fs.readdirSync(examDir).filter((f) => f.endsWith('.json')).sort();
let totalQ = 0;
let totalFlagged = 0;
let totalItems = 0;
let confirmedQ = 0;
let unconfirmedQ = 0;
let totalAssets = 0;
let unknownTags = new Set();
// 富媒体题干的契约问题，攒齐一起报——一次只报一条的话，出题人要跑十次才知道
// 十道题都有什么毛病
const badAssets = [];
// 题目资源在盘上的位置。path 的第一段是**学科码**（与 /bank/<code>/... 这个 URL
// 对齐），文件实际在 data/subjects/<code>/assets/<剩下那段> 下。
// 第一段对不上本学科时直接当成"文件不在盘上"报出来——那多半是把别的学科的图
// 抄到这道题上了，而它会在学生面前变成一个破图，没有任何地方报错。
const assetRoot = path.join(subjectDir, 'assets');
const assetExists = (rel) => {
  const [code, ...rest] = String(rel).split('/');
  if (code !== subjectCode || !rest.length) return false;
  return fs.existsSync(path.join(assetRoot, ...rest));
};

// 内容组的身份（§6.4.2）。蓝本叫 examId/title/year/month，生化叫 groupId/label/orderKey。
// 两套名字都认，但**落库只有一种形状**：order_key 排序、label 显示、meta 存展示用的杂项。
function contentGroupOf(d, file) {
  const groupId = d.examId || d.groupId;
  if (!groupId) throw new Error(`${file}：既没有 examId 也没有 groupId`);
  const label = d.label || d.title;
  if (!label) throw new Error(`${file}：既没有 title 也没有 label，内容组没有显示名`);
  // order_key 是内容组之间唯一的结构性差异。**没有就抛错，不要回落成 0**——
  // 0 是个合法的排序键，回落之后这一组会静默排到最前面，而排序错了不报错。
  const hasYm = Number.isInteger(d.year) && Number.isInteger(d.month);
  const orderKey = Number.isInteger(d.orderKey) ? d.orderKey : (hasYm ? d.year * 100 + d.month : null);
  if (orderKey === null) {
    throw new Error(`${file}：算不出 order_key（既没有 orderKey，也没有成对的 year/month）`);
  }
  const meta = {};
  for (const k of ['year', 'month', 'chapterNo', 'groupKind', 'courseName', 'totalScore', 'timeLimitMinutes']) {
    if (d[k] !== undefined && d[k] !== null) meta[k] = d[k];
  }
  return {
    groupId,
    label,
    title: d.title || label,
    orderKey,
    // year/month 是 NOT NULL 而生化没有年月，所以这里写 0；读出去那一刻映射回 null
    // （worker/src/lib/content-group.js）。理由见 0002_bank.sql。
    year: hasYm ? d.year : 0,
    month: hasYm ? d.month : 0,
    meta: Object.keys(meta).length ? JSON.stringify(meta) : null,
  };
}

// 答案状态与来源（§6.4.10）。**组级必填，不给默认值**：默认成"已确认"会让一份
// 忘了声明的新学科题库带着没人核过的答案直接可发布可抽题，而这件事不会报错。
function answerStateOf(d, qu, file) {
  const state = qu.answerState || d.answerState;
  if (!ANSWER_STATES.includes(state)) {
    throw new Error(
      `${file}：答案状态缺失或非法（题 ${qu?.questionId || '组级'}，收到 ${JSON.stringify(state)}）。` +
      `内容组要在顶层声明 answerState，取值 ${ANSWER_STATES.join(' / ')}`);
  }
  const source = qu.answerSource || d.answerSource || null;
  if (state !== '缺答案' && !ANSWER_SOURCES.includes(source)) {
    throw new Error(
      `${file}：答案状态是「${state}」却说不清来源（题 ${qu?.questionId || '组级'}，收到 ` +
      `${JSON.stringify(source)}）。取值 ${ANSWER_SOURCES.join(' / ')}`);
  }
  // 留痕只在"已确认"时有意义：待核的答案按定义就是还没人确认。
  const by = state === ANSWER_CONFIRMED ? (qu.answerReviewedBy || d.answerReviewedBy || null) : null;
  const at = state === ANSWER_CONFIRMED ? (qu.answerReviewedAt || d.answerReviewedAt || null) : null;
  return { state, source, by, at };
}

for (const file of files) {
  const d = JSON.parse(fs.readFileSync(path.join(examDir, file), 'utf8'));
  const courseCode = courseOf(d.courseCode);
  const g = contentGroupOf(d, file);
  const flagged = flaggedOrders(d);
  const lines = [];

  // 幂等：重复导入时先清掉这套卷的旧数据，避免主键冲突或残留
  lines.push(
    `DELETE FROM question_knowledge_points WHERE question_id IN (SELECT question_id FROM questions WHERE exam_id = ${q(g.groupId)});`,
    // 资源行跟着题一起清。不清的话重导之后会留下指向已删题目的孤儿行，
    // 而外键在 D1 上默认不强制，不会有任何地方报错。
    `DELETE FROM question_assets WHERE question_id IN (SELECT question_id FROM questions WHERE exam_id = ${q(g.groupId)});`,
    `DELETE FROM question_items WHERE question_id IN (SELECT question_id FROM questions WHERE exam_id = ${q(g.groupId)});`,
    `DELETE FROM questions WHERE exam_id = ${q(g.groupId)};`,
    `DELETE FROM sections WHERE exam_id = ${q(g.groupId)};`,
    `DELETE FROM exam_parsing_notes WHERE exam_id = ${q(g.groupId)};`,
    `DELETE FROM exams WHERE exam_id = ${q(g.groupId)};`
  );

  lines.push(
    `INSERT INTO exams (exam_id, course_code, title, label, order_key, meta, year, month, ` +
      `source_file, status) VALUES (` +
      `${q(g.groupId)}, ${q(courseCode)}, ${q(g.title)}, ${q(g.label)}, ${n(g.orderKey)}, ` +
      `${q(g.meta)}, ${n(g.year)}, ${n(g.month)}, ` +
      `${q(d.sourceFile)}, ${q(d.status || '待校对')});`
  );

  for (const s of d.sections) {
    lines.push(
      `INSERT INTO sections (section_id, exam_id, type, ord, passage_title, passage_text, ` +
        `writing_prompt, score_per_question, total_score) VALUES (` +
        `${q(s.sectionId)}, ${q(g.groupId)}, ${q(s.type)}, ${n(s.order)}, ${q(s.passageTitle)}, ` +
        `${q(s.passageText)}, ${q(s.writingPrompt)}, ${n(s.scorePerQuestion)}, ${n(s.totalScore)});`
    );

    for (const qu of s.questions) {
      totalQ++;
      if (flagged.has(qu.order)) totalFlagged++;

      // 富媒体题干的契约（§6.4.6、G2）：引用的 key 必须存在、IMAGE 的 alt 必填、
      // 路径指向的文件必须真在盘上。**在这里拒，不在发布时拒**——种子生成是
      // 唯一一个既看得到 JSON 又看得到文件系统的环节。
      const assetProblems = validateAssets(
        {
          questionId: qu.questionId,
          stem: qu.stem,
          options: qu.options,
          itemAnswers: (qu.items || []).map((it) => it.answer),
        },
        qu.assets,
        { fileExists: assetExists },
      );
      if (assetProblems.length) badAssets.push(...assetProblems);
      for (const a of qu.assets || []) {
        totalAssets++;
        lines.push(
          `INSERT INTO question_assets (question_id, asset_key, subject_id, kind, path, alt, caption) VALUES (` +
            `${q(qu.questionId)}, ${q(a.key)}, ` +
            `(SELECT subject_id FROM courses WHERE course_code = ${q(courseCode)}), ` +
            `${q(a.kind)}, ${q(a.path)}, ${q(a.alt)}, ${q(a.caption)});`
        );
      }
      // 答案状态与校对状态是两个维度（§6.4.10 在本项目的落实，见 0002_bank.sql）。
      // 解析记录点名的题落 status='存疑'；答案能不能拿来判分由 answer_state 单独说。
      const a = answerStateOf(d, qu, file);
      if (a.state === ANSWER_CONFIRMED) confirmedQ++; else unconfirmedQ++;
      lines.push(
        `INSERT INTO questions (question_id, section_id, exam_id, course_code, section_type, ord, ` +
          `question_type, stem, options, answer, answer_explanation, difficulty_tag, status, ` +
          `answer_state, answer_source, answer_reviewed_by, answer_reviewed_at, subject_id) VALUES (` +
          `${q(qu.questionId)}, ${q(s.sectionId)}, ${q(g.groupId)}, ${q(courseCode)}, ${q(s.type)}, ` +
          `${n(qu.order)}, ${q(qu.questionType)}, ${q(qu.stem)}, ` +
          `${qu.options ? q(JSON.stringify(qu.options)) : 'NULL'}, ${q(qu.answer)}, ` +
          `${q(qu.answerExplanation)}, ${q(qu.difficultyTag)}, ` +
          `${flagged.has(qu.order) ? "'存疑'" : "'草稿'"}, ` +
          `${q(a.state)}, ${q(a.source)}, ${q(a.by)}, ${q(a.at)}, ` +
          // N3：从 courses 现取，不写死。题型校验与报告分层都按它过滤。
          `(SELECT subject_id FROM courses WHERE course_code = ${q(courseCode)}));`
      );
      // 得分单元（§6.4.5）。**不写进去等于把 21 道题的答案静默丢掉**：
      // 判分器读不到 items 就回落到 questions.answer 那条单元素路径，
      // 而多空题的 answer 是空的——学生怎么答都判错，没有任何地方报错。
      for (const it of qu.items || []) {
        totalItems++;
        if (!ITEM_KINDS.includes(it.kind)) {
          throw new Error(`${qu.questionId} 的得分单元 #${it.ord} 的 kind 是 ` +
            `${JSON.stringify(it.kind)}，只认 ${ITEM_KINDS.join('、')}`);
        }
        lines.push(
          `INSERT INTO question_items (question_id, item_ord, subject_id, item_kind, ` +
            `grading_strategy, group_key, answer, alt_answers, weight, params) VALUES (` +
            `${q(qu.questionId)}, ${n(it.ord)}, ` +
            `(SELECT subject_id FROM courses WHERE course_code = ${q(courseCode)}), ` +
            `${q(it.kind)}, ${q(it.strategy)}, ${q(it.groupKey)}, ${q(it.answer)}, ` +
            `${it.altAnswers ? q(JSON.stringify(it.altAnswers)) : 'NULL'}, ` +
            `${n(it.weight ?? 1)}, ${it.params ? q(JSON.stringify(it.params)) : 'NULL'});`
        );
      }
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
    const nt = normalizeNote(note);
    lines.push(
      `INSERT INTO exam_parsing_notes (exam_id, note, note_kind, corrected_from, corrected_to, ` +
        `corrected_by, corrected_at) VALUES (` +
        `${q(g.groupId)}, ${q(nt.note)}, ${q(nt.kind)}, ${q(nt.correctedFrom)}, ${q(nt.correctedTo)}, ` +
        `${q(nt.correctedBy)}, ${nt.correctedFrom ? "datetime('now')" : 'NULL'});`
    );
  }

  const outName = `${String(files.indexOf(file) + 1).padStart(3, '0')}-${g.groupId}.sql`;
  pending.push([outName, lines]);
}

if (unknownTags.size) {
  for (const t of unknownTags) {
    const last = String(t).split('/').pop();
    console.error(ambiguous.has(last)
      ? `错误：考点标签「${t}」对应多个考点，请写成全路径（父名/子名）`
      : `错误：考点标签「${t}」不在 knowledge-points.json 中`);
  }
  process.exit(1);
}

// G2：资源契约不过关的题**逐条打印题号**并让生成失败。
// 只打印"有 3 道题有问题"等于没说——出题人要的是"哪道题、缺什么"。
if (badAssets.length) {
  console.error(`错误：${badAssets.length} 处富媒体题干不合契约（§6.4.6）：`);
  for (const p of badAssets) console.error(`  - ${p}`);
  process.exit(1);
}

// 校验全过了才落盘。清旧文件也放在这里：生成失败时目录保持原样，
// 而不是留下一个空目录——那样"生成器失败了"会以"题库怎么没了"的形式出现。
for (const f of fs.readdirSync(outDir)) {
  if (f.endsWith('.sql')) fs.unlinkSync(path.join(outDir, f));
}
for (const [name, lines] of pending) writeSeedFile(outDir, name, lines);

console.log(`生成完成：${files.length} 套试卷，${totalQ} 道题，${totalItems} 个得分单元，${totalAssets} 个题目资源，` +
  `${kps.length} 个考点标签 -> ${outDir}`);
console.log(`其中 ${totalFlagged} 道被解析存疑记录点名，标为"存疑"，不参与组卷与练习。`);
console.log(`答案状态：${confirmedQ} 道已确认（可发布可抽题），${unconfirmedQ} 道未确认` +
  `（缺答案或待核，发布时会被扣下，抽题抽不到）。`);
