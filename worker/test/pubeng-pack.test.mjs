// 公共英语学科的声明（迁移 0018，2026-11-07）：能力包读得出来、组卷模板和文件一致、门闩管用、
// 题库文件里每道题的标准答案判分器都判得满。纯 node，不起服务。
//
// 生化当初漏过三样声明，每一样都"不报错但用不了"：课程行（0013 补）、组卷模板（0017 补）、
// 主观题批改提示词（0017 换）。新学科一次声明齐，这里逐样断它们在库里、读得出来。
// 期望值从仓库文件现算（exam-template.json、groups/*.json），不写死题数。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDb, WORKER_ROOT } from './lib/d1-sqlite.mjs';
import { loadPackByCourse } from '../src/lib/subject-pack.js';
import { answerKeyProblems } from '../src/lib/answer-check.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};

const REPO = join(WORKER_ROOT, '..');
const SUBJ = join(REPO, 'data/subjects/pubeng');
const { sqlite, DB, one } = makeDb();
const all = (sql, ...p) => sqlite.prepare(sql).all(...p).map((r) => ({ ...r }));

// 公共英语的种子现生成（不消费别人留下的产物，CLAUDE.md 三、"改了 build-seed-sql.mjs"那条）
const out = mkdtempSync(join(tmpdir(), 'pubeng-seed-'));
try {
  const r = spawnSync(process.execPath, [join(REPO, 'scripts/build-seed-sql.mjs'), out],
    { env: { ...process.env, SEED_SUBJECT_DIR: SUBJ }, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`生成公共英语种子失败：${(r.stderr || r.stdout).slice(-400)}`);
  for (const f of readdirSync(out).sort()) sqlite.exec(readFileSync(join(out, f), 'utf8'));
} finally {
  rmSync(out, { recursive: true, force: true });
}
const groupFiles = readdirSync(join(SUBJ, 'groups')).filter((f) => f.endsWith('.json'));
const groups = groupFiles.map((f) => JSON.parse(readFileSync(join(SUBJ, 'groups', f), 'utf8')));
const fileQuestions = groups.flatMap((g) => g.sections.flatMap((s) => s.questions.map((q) => ({ ...q, sectionType: s.type }))));

console.log('== 学科、课程、能力包 ==');
check('学科行在、启用', one(`SELECT status FROM subjects WHERE code = 'pubeng'`)?.status, '启用');
check('课程行挂在公共英语上', one(`SELECT s.code FROM courses co JOIN subjects s ON s.subject_id = co.subject_id
                                     WHERE co.course_code = 'pubeng-main'`)?.code, 'pubeng');
const pack = await loadPackByCourse(DB, 'pubeng-main');
check('能力包读得出来（题型、评价标准都在、彼此一致）', pack.code, 'pubeng');
const declared = [...pack.types.keys()].sort().join(',');
const used = [...new Set(fileQuestions.map((q) => q.questionType))].sort();
check('题库文件里用到的题型都声明了', used.filter((t) => !pack.types.has(t)).join(',') || '无', '无');
check('三种翻译题都按采分点 AI 批改', ['phrase_translate', 'sentence_translate', 'paragraph_translate']
  .map((t) => pack.typeOf(t).gradingStrategy).join(','), 'AI_SCORE_POINTS,AI_SCORE_POINTS,AI_SCORE_POINTS');
console.log(`     （声明的题型：${declared}）`);
check('四类 AI 提示词都在', all(`SELECT feature FROM subject_ai_prompts WHERE subject_id =
  (SELECT subject_id FROM subjects WHERE code = 'pubeng') ORDER BY feature`).map((r) => r.feature).join(','),
  'answer_explain,assessment,essay_grade,wrong_analyze');
check('主观题批改提示词是按采分点批的那份（变量是 {{pointLines}}，不是英语作文的 {{dimensionLines}}）',
  /\{\{pointLines\}\}/.test(one(`SELECT user_template FROM subject_ai_prompts WHERE feature = 'essay_grade'
    AND subject_id = (SELECT subject_id FROM subjects WHERE code = 'pubeng')`).user_template), true);

console.log('== 组卷模板：库里的和 exam-template.json 逐项一致 ==');
const tpl = JSON.parse(readFileSync(join(SUBJ, 'exam-template.json'), 'utf8'));
const rows = all(`SELECT ord, label, filter, question_count, score_mode, score_per_question, pick_unit
                    FROM exam_template_items WHERE course_code = 'pubeng-main' ORDER BY ord`);
check('模板项数', rows.length, tpl.items.length);
for (const it of tpl.items) {
  const r = rows.find((x) => x.ord === it.ord);
  check(`  第 ${it.ord} 项 ${it.label}`, r && JSON.stringify([r.label, JSON.parse(r.filter), r.question_count,
    r.score_mode, r.score_per_question, r.pick_unit]),
  JSON.stringify([it.label, it.filter, it.questionCount, it.scoreMode, it.scorePerQuestion, it.pickUnit]));
}
const total = tpl.items.reduce((s, it) => s + it.questionCount * it.scorePerQuestion, 0);
check('模板各项分值加起来 = 课程满分', total, one(`SELECT total_score FROM courses WHERE course_code = 'pubeng-main'`).total_score);
check('  也 = 文件里写的满分', total, tpl.totalScore);

console.log('== 门闩：管理员改过、删过的，下一次部署（迁移重跑）不冲回去 ==');
const MIG = readFileSync(join(WORKER_ROOT, 'migrations/0018_pubeng.sql'), 'utf8');
sqlite.exec(`DELETE FROM exam_template_items WHERE course_code = 'pubeng-main' AND ord = 8`);
sqlite.exec(`UPDATE subject_question_types SET normalizers = '["choice"]'
              WHERE type_code = 'single_choice' AND subject_id = (SELECT subject_id FROM subjects WHERE code = 'pubeng')`);
sqlite.exec(`UPDATE subject_ai_prompts SET user_template = '管理员改过的' WHERE feature = 'wrong_analyze'
              AND subject_id = (SELECT subject_id FROM subjects WHERE code = 'pubeng')`);
sqlite.exec(MIG);
check('删掉的模板项没被插回来', one(`SELECT COUNT(*) AS n FROM exam_template_items WHERE course_code = 'pubeng-main' AND ord = 8`).n, 0);
check('改过的题型归一化器没被冲回去', one(`SELECT normalizers FROM subject_question_types WHERE type_code = 'single_choice'
  AND subject_id = (SELECT subject_id FROM subjects WHERE code = 'pubeng')`).normalizers, '["choice"]');
check('改过的提示词没被冲回去', one(`SELECT user_template FROM subject_ai_prompts WHERE feature = 'wrong_analyze'
  AND subject_id = (SELECT subject_id FROM subjects WHERE code = 'pubeng')`).user_template, '管理员改过的');
check('学科行没有多出一行', one(`SELECT COUNT(*) AS n FROM subjects WHERE code = 'pubeng'`).n, 1);

console.log('== 题库文件：每道题的标准答案判分器都判得满 ==');
// 判据就是判分器本身（answer-check.js），确认、发布、看板都用它——这里先替后台判一遍
const dbQs = all(`SELECT question_id, question_type, answer, answer_state FROM questions WHERE course_code = 'pubeng-main'`);
check('库里的题数 = 题库文件里的题数', dbQs.length, fileQuestions.length);
const itemRows = all(`SELECT * FROM question_items WHERE question_id IN (SELECT question_id FROM questions
                       WHERE course_code = 'pubeng-main')`);
const problems = [];
for (const q of dbQs) {
  const p = answerKeyProblems(pack, q, itemRows.filter((r) => r.question_id === q.question_id), q.question_id);
  if (p.length) problems.push(...p);
}
check('没有判不满的题', problems.length, 0);
for (const p of problems.slice(0, 10)) console.log(`       ${p}`);
const byState = {};
for (const q of dbQs) byState[q.answer_state] = (byState[q.answer_state] || 0) + 1;
console.log(`     （${groupFiles.length} 个内容组 ${dbQs.length} 题；答案状态：${JSON.stringify(byState)}）`);
// 单词、词组的答案是原书的表（已确认）；句子、段落翻译的采分点是 Claude 拆的（待核）——文件怎么写库里就怎么落
const groupStateOf = new Map(groups.flatMap((g) => g.sections.flatMap((s) => s.questions.map((q) => [q.questionId, g.answerState]))));
const fileState = (q) => q.answerState || groupStateOf.get(q.questionId);
check('待核的题数和题库文件一致（Claude 拆的采分点不会被当成已确认）', byState['待核'] || 0,
  fileQuestions.filter((q) => fileState(q) === '待核').length);
check('翻译题没有一道是已确认的（采分点都得人看过）', dbQs.filter((q) => ['sentence_translate', 'paragraph_translate']
  .includes(q.question_type) && q.answer_state === '已确认').length, 0);

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
