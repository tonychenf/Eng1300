// 组卷：同一张卷里，两个整篇抽题的模板项筛出同一批篇章时，不能抽到同一篇（2026-11-07）。纯 node，不起服务。
//
// 起因是公共英语：样卷的阅读理解是两篇各 5 题，拆成两个"阅读理解"整篇抽的模板项。以前每个模板项
// 各抽各的，第二项可能又抽到第一项那篇——同一题进卷两次，attempt_questions 撞主键，组卷 500；
// 而后台的"能不能组卷"（examReadiness）每项各算各的，只有一篇也报"凑得够"。
//
// 拿英语的真题造场景：把 13000 的组卷模板换成两个都筛「阅读理解选择」的整篇抽模板项（每套真题里
// 这一类正好一篇 5 题）。两篇以上可选时断"抽到的是两篇不同的"；只剩一篇时断"组卷报凑不够、
// readiness 报第二项凑不够"——这一条旧代码上一定红（只有一篇可选，旧代码两项都抽它）。
import { makeDb } from './lib/d1-sqlite.mjs';
import { planPaper, examReadiness } from '../src/lib/paper.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};

const { sqlite, DB, one } = makeDb({
  seeds: ['english-000-knowledge-points', '00015-2015-04', '00015-2016-04', '00015-2019-10', '13000-2026-04'],
  fixtures: ['test/fixtures/publish-all.sql'],
});
const TYPE = '阅读理解选择';
sqlite.exec(`DELETE FROM exam_template_items WHERE course_code = '13000'`);
for (const ord of [1, 2]) {
  sqlite.prepare(`INSERT INTO exam_template_items (course_code, ord, label, filter, question_count, score_mode,
                    score_per_question, pick_unit) VALUES ('13000', ?, ?, ?, 5, 'FROM_TEMPLATE', 2, 'SECTION')`)
    .run(ord, `阅读（${ord}）`, JSON.stringify({ sectionTypes: [TYPE] }));
}
// 可选篇章 = 已发布题正好 5 道的那几篇（和 candidateSections 同一个口径：抽题判据 pickableSql）
const candidates = () => sqlite.prepare(
  `SELECT s.section_id FROM sections s JOIN exams e ON e.exam_id = s.exam_id
    WHERE e.course_code = '13000' AND s.type = ?
      AND (SELECT COUNT(*) FROM questions q WHERE q.section_id = s.section_id AND q.status = '已发布'
             AND q.answer_state = '已确认' AND q.retired_at IS NULL) = 5`).all(TYPE).map((r) => r.section_id);

console.log('== 两篇以上可选：两项抽到的是不同的两篇 ==');
{
  const pool = candidates();
  console.log(`     （可选的「${TYPE}」篇章 ${pool.length} 篇：${pool.join('、')}）`);
  check('可选篇章至少两篇（前提成立）', pool.length >= 2, true);
  let same = 0, dupQ = 0;
  for (let i = 0; i < 20; i++) {
    const { parts } = await planPaper(DB, { courseCode: '13000', userId: 900000 + i });
    const secs = parts.map((p) => p.questions[0].sectionId);
    if (secs[0] === secs[1]) same++;
    const ids = parts.flatMap((p) => p.questions.map((q) => q.questionId));
    if (new Set(ids).size !== ids.length) dupQ++;
  }
  check('组 20 次，没有一次两项抽到同一篇', same, 0);
  check('组 20 次，没有一次同一题进卷两次', dupQ, 0);
}

console.log('== 只剩一篇可选：组卷报凑不够，readiness 也报凑不够 ==');
{
  const [keep, ...rest] = candidates();
  for (const s of rest) sqlite.prepare(`UPDATE questions SET status = '草稿' WHERE section_id = ?`).run(s);
  check('只剩一篇可选（前提成立）', candidates().length, 1);
  let err = null;
  try {
    await planPaper(DB, { courseCode: '13000', userId: 900100 });
  } catch (e) { err = e; }
  check('组卷抛 insufficient_questions（不是抽两次同一篇、也不是撞主键）', err?.code, 'insufficient_questions');
  check('  说的是第二项凑不够', /阅读（2）/.test(String(err?.message)), true);
  const r = (await examReadiness(DB)).find((x) => x.courseCode === '13000');
  check('readiness：第一项凑得够', r.parts[0].ok, true);
  check('readiness：第二项凑不够（第一项占掉了唯一那篇）', r.parts[1].ok, false);
  check('readiness：整门课报不能组卷', r.ready, false);
  check('留下的那篇确实是可选的那篇（前提的另一半）', one(
    `SELECT COUNT(*) AS n FROM questions WHERE section_id = ? AND status = '已发布'`, keep).n, 5);
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
