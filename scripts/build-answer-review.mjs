// 从题库 JSON 生成人工核对用的答案卷。
//
// 为什么要有这个脚本而不是手写一份 Markdown：答案卷是派生物，手写的话它和题库
// JSON 会各改各的，核对的人看到的和入库的对不上——这种不一致最难发现，因为两边
// 单独看都是对的。生成出来就不会漂。
//
// 用法：node scripts/build-answer-review.mjs [学科码]     默认 biochem
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const subject = process.argv[2] || 'biochem';
const dir = join('data/subjects', subject, 'groups');
if (!existsSync(dir)) { console.error(`没有 ${dir}`); process.exit(1); }

// 填空题的一行：把同 groupKey 的空并成一组显示，组内注明顺序不限
function fillAnswer(q) {
  const groups = new Map();
  for (const it of q.items) {
    const key = it.groupKey || `_${it.ord}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(it);
  }
  return [...groups].map(([key, g]) => {
    if (key.startsWith('_')) {
      const it = g[0];
      let a = it.answer + (it.strategy === 'NUMERIC' ? (it.params?.unit ?? '') : '');
      if (it.altAnswers?.length) a += ` _（也接受：${it.altAnswers.join('／')}）_`;
      return a;
    }
    const { pool, requiredCount } = g[0].params;
    const open = requiredCount < pool.length ? `，任选 ${requiredCount}` : '';
    return `${pool.join('、')} _（顺序不限${open}）_`;
  }).join('；');
}

for (const file of readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
  const d = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const out = [];
  const w = (s) => out.push(s);

  // 抬头要从 JSON 现算，不能写死。
  //
  // 这个文件存在的理由就是"答案卷是派生物、手写会和题库 JSON 各改各的"，
  // 而头部原来是三行写死的文案：题库里状态已经从「待核」转「草稿」、复核也做过了，
  // 生成出来的文件却还在说"未经人工核对、全部 status = 待核"。
  // 派生物里混一段写死的话，比整篇手写更难发现——正文是新的，只有抬头是旧的。
  const statuses = [...new Set(d.sections.flatMap((s) => s.questions.map((q) => q.status)))].sort();
  const reviewed = Boolean(d.answerReviewed);

  w(`# ${d.label} — 答案与采分点（${reviewed ? '已复核' : '待核对'}）\n`);
  w('> 本文件由 `scripts/build-answer-review.mjs` 生成，不要手改——改题库 JSON 再重新生成。\n');
  if (reviewed) {
    w(`> **已复核**：${d.answerReviewedBy || '未记录复核人'}${d.answerReviewedAt ? `，${d.answerReviewedAt}` : ''}。`);
  } else {
    w('> **未经核对。**');
  }
  w(`> 当前题目状态：\`${statuses.join('` / `')}\`。`);
  w('> 按需求文档 §6.4.9，AI 生成的答案绝不能自动发布：答案是判分的基准，');
  w('> 错一个会让所有做对的学生被判错。\n');
  if (d.answerNote) w(`> ${d.answerNote}\n`);
  w('核对方式：对着原卷逐题看「答案」列；有疑问的看文末「存疑记录」。\n\n---\n');

  for (const s of d.sections) {
    w(`## ${s.type}（${s.questions.length} 题）\n`);
    if (s.type === '填空题') {
      w('| # | 题干 | 答案（按空） |\n|---|---|---|');
      for (const q of s.questions) {
        w(`| ${q.order} | ${q.stem.replaceAll('|', '\\|')} | ${fillAnswer(q)} |`);
      }
    } else if (s.type === '选择题') {
      w('| # | 题干 | 答案 |\n|---|---|---|');
      for (const q of s.questions) {
        const picked = q.options.find((o) => o.startsWith(`${q.answer}.`)) ?? q.answer;
        const mark = q.correctionApplied ? ' ⚠️已订正选项标号' : '';
        w(`| ${q.order} | ${q.stem.replaceAll('|', '\\|')}<br>${q.options.join(' / ')} | **${picked}**${mark} |`);
      }
    } else {
      for (const q of s.questions) {
        const total = q.items.reduce((n, i) => n + i.weight, 0);
        w(`**${q.order}. ${q.stem}** （${total} 分权重，${q.items.length} 个采分点）\n`);
        for (const it of q.items) w(`- [${it.weight} 分] ${it.answer}`);
        w('');
      }
    }
    w('');
  }

  w('---\n\n## 存疑记录（人工核对时重点看这几条）\n');
  for (const n of d.parsingNotes ?? []) {
    w(`### ${n.kind} · 第 ${n.questionOrders.join('、')} 题\n\n${n.note}\n`);
    if (n.correctedFrom) w(`- 原文：\`${n.correctedFrom}\`\n- 改后：\`${n.correctedTo}\`\n`);
  }

  const dest = join('data/subjects', subject, `ANSWER_REVIEW_${d.groupId.replace(/^.*-/, '')}.md`);
  writeFileSync(dest, out.join('\n'));
  const items = d.sections.flatMap((s) => s.questions.flatMap((q) => q.items ?? []));
  console.log(
    `${dest}  ${d.sections.reduce((n, s) => n + s.questions.length, 0)} 题 / ` +
    `${items.filter((i) => i.kind === 'BLANK').length} 空 / ` +
    `${items.filter((i) => i.kind === 'SCORE_POINT').length} 采分点`
  );
}
