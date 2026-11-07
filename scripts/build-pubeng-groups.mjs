#!/usr/bin/env node
// 公共英语：从转写稿生成题库文件（data/subjects/pubeng/groups/*.json）。
//
//   node scripts/build-pubeng-groups.mjs            # 生成能生成的；缺答案的内容组跳过并点名
//   node scripts/build-pubeng-groups.mjs --check    # 只检查、不写文件（生成结果和盘上的文件不一致就退出 1）
//
// 输入都在 data/subjects/pubeng/source/：
//   mc-set1.txt / mc-set2.txt   两组选择题强化训练（题号|题干|A|B|C|D）
//   sample-test2.json           第四段考试样卷 2
//   units.json                  第四段教学重点（单词、词组、句子翻译、精选段落，答案是原书给的）
//   translation-points.json     教学重点句子翻译的采分点（Claude 拆的，待核）
//   answers.json                用户提供的答案（选择题两组、样卷 2）。**没有它，这三个内容组不生成**
//
// 为什么缺答案就不生成、而不是生成一份"缺答案"的：题库文件一旦导入线上就不许改（CR-H4），
// 答案只能在后台逐题补——400 道选择题逐题点不现实。所以要等答案齐了一次生成。
//
// **已经导入线上的题库文件不能再生成覆盖**：生成器只写盘上还不存在的文件，存在的拿来比对，
// 不一样就报错（--check 同理）。要改内容只能停用旧题、换新的内容组编号（CLAUDE.md 四、CR-H4）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SUBJ = path.join(ROOT, 'data/subjects/pubeng');
const SRC = path.join(SUBJ, 'source');
const OUT = path.join(SUBJ, 'groups');
const CHECK = process.argv.includes('--check');

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const pad = (n, w = 3) => String(n).padStart(w, '0');
const fail = (msg) => { throw new Error(msg); };

// ---------- 选择题的考点初挂 ----------
// 是初挂不是定论（knowledge-points.json 的 note 写了），后台校对页可改。判据按选项形态，
// 语法题按题号点名——光看选项分不出"时态""虚拟"和普通的词义辨析。
const GRAMMAR = {
  'mc-set1': [33, 34, 40, 42, 55, 75, 104, 105, 118, 122, 125, 140, 141, 156, 158, 160, 172, 182, 185, 200],
  'mc-set2': [11, 12, 14, 30, 38, 41, 42, 63, 75, 96, 126, 127, 132, 133, 161, 169, 170, 175, 178, 182, 189],
  test2: [1, 4, 7, 8, 12, 13, 23],
};
const PREPS = new Set(['in', 'on', 'at', 'for', 'from', 'with', 'to', 'by', 'of', 'into', 'off', 'over', 'under',
  'among', 'between', 'about', 'without', 'against', 'beneath', 'as', 'than', 'through', 'up', 'out']);
function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function choiceTag(set, no, opts) {
  if (GRAMMAR[set]?.includes(no)) return '语法/语法结构';
  const low = opts.map((o) => o.toLowerCase());
  if (low.every((o) => PREPS.has(o))) return '词汇/介词与副词小品词';
  if (low.every((o) => /\s/.test(o))) return '词汇/短语与固定搭配';
  // 四个选项里至少三个和第一个（或彼此）共享 4 个字母以上的词头：同词根的不同词形
  let best = 0;
  for (const a of low) best = Math.max(best, low.filter((b) => commonPrefix(a, b) >= 4).length);
  if (best >= 3) return '词汇/词形与派生';
  return '词汇/词义辨析';
}

// ---------- 答案 ----------
function letters(raw, count, where) {
  // 两种写法都认："ABCD…"（空白忽略）或 {"1":"A", …}
  const arr = typeof raw === 'string'
    ? raw.replace(/\s+/g, '').toUpperCase().split('')
    : Array.from({ length: count }, (_, i) => String(raw?.[i + 1] ?? '').trim().toUpperCase());
  if (arr.length !== count) fail(`${where}：答案应当有 ${count} 个，收到 ${arr.length} 个`);
  arr.forEach((a, i) => { if (!/^[A-D]$/.test(a)) fail(`${where}：第 ${i + 1} 题的答案是 ${JSON.stringify(a)}，只认 A–D`); });
  return arr;
}
function answerMeta(answers) {
  const source = answers?.answerSource;
  if (!['OFFICIAL', 'MANUAL'].includes(source)) {
    fail(`answers.json：answerSource 要写 OFFICIAL（原书 / 出版方答案）或 MANUAL（老师手做的），收到 ${JSON.stringify(source)}`);
  }
  if (!answers.reviewedBy || !answers.reviewedAt) fail('answers.json：要写 reviewedBy（谁提供的）和 reviewedAt（日期）');
  return { answerState: '已确认', answerSource: source, answerReviewedBy: answers.reviewedBy, answerReviewedAt: answers.reviewedAt };
}

// ---------- 选择题强化训练 ----------
function parseMc(file) {
  const rows = fs.readFileSync(path.join(SRC, file), 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  return rows.map((l, i) => {
    const f = l.split('|');
    if (f.length !== 6 || Number(f[0]) !== i + 1) fail(`${file} 第 ${i + 1} 行形状不对：${l.slice(0, 60)}`);
    return { no: i + 1, stem: f[1], opts: f.slice(2) };
  });
}
function mcGroup({ set, groupId, label, orderKey, sourcePages, answers }) {
  const items = parseMc(`${set}.txt`);
  const key = letters(answers[set], items.length, `answers.json 的 ${set}`);
  const notes = [];
  if (set === 'mc-set1') {
    notes.push({ kind: '原题有误', questionOrders: [52],
      note: '第 52 题原件选项标号是 A/B/B/D（第三项也印成了 B），按位置订正为 C，选项文字未改。',
      correctedFrom: 'A）situations  B）cases  B）places  D）occasions',
      correctedTo: 'A. situations  B. cases  C. places  D. occasions' });
  }
  return {
    groupId, subjectCode: 'pubeng', courseCode: 'pubeng-main', groupKind: 'EXERCISE_SET', orderKey, label,
    sourceFile: `公共英语课程教学重点与考试样卷（扫描件）第 ${sourcePages} 页`,
    ...answerMeta(answers),
    sections: [{
      sectionId: `${groupId}-s1`, type: '选择填空', order: 1,
      questions: items.map((it, i) => ({
        questionId: `${groupId}-q${pad(it.no)}`, order: it.no, questionType: 'single_choice', status: '草稿',
        stem: it.stem, options: it.opts.map((o, j) => `${LETTERS[j]}. ${o}`), answer: key[i],
        knowledgePoints: [choiceTag(set, it.no, it.opts)],
      })),
    }],
    parsingNotes: notes,
  };
}

// ---------- 教学重点（每课一个内容组，答案是原书给的） ----------
const UNIT_TAG = {
  b1u09: '教材课文/第一册第9课 Is There Life on Earth',
  b1u10: '教材课文/第一册第10课 Going Home',
  b2u01: '教材课文/第二册第1课 The Dinner Party',
  b2u02: '教材课文/第二册第2课 Lessons from Jefferson',
};
const splitZh = (zh) => zh.replace(/\n+/g, '').split(/(?<=[。！？])/).map((s) => s.trim()).filter(Boolean);
function paragraphItems(zh) {
  return splitZh(zh).map((s, i) => ({ ord: i + 1, kind: 'SCORE_POINT', strategy: 'AI_SCORE_POINTS', answer: `译出：${s}`, weight: 1 }));
}
function unitGroup(u, points, orderKey) {
  const gid = `pubeng-s4-${u.id}`;
  const unitTag = UNIT_TAG[u.id] || fail(`units.json 的 ${u.id} 没有对应的考点（knowledge-points.json 和 UNIT_TAG 要一起加）`);
  const pts = points.sentences[u.id] || fail(`translation-points.json 没有 ${u.id} 的句子采分点`);
  if (pts.length !== u.sentences.length) fail(`${u.id}：句子 ${u.sentences.length} 句，采分点 ${pts.length} 组，对不上`);
  const book = { answerState: '已确认', answerSource: 'OFFICIAL', answerReviewedBy: '原书教学重点（单词表、词组表、译文）', answerReviewedAt: '2026-11-07' };
  const pending = { answerState: '待核', answerSource: 'AI' };
  let order = 0;
  const q = (extra) => ({ questionId: `${gid}-q${pad(++order)}`, order, status: '草稿', ...extra });
  return {
    groupId: gid, subjectCode: 'pubeng', courseCode: 'pubeng-main', groupKind: 'TEXTBOOK_UNIT', orderKey,
    label: `第四段教学重点 第${u.book === 1 ? '一' : '二'}册第${u.unit}课 ${u.title}`,
    sourceFile: `公共英语课程教学重点与考试样卷（扫描件）第 ${u.pages} 页`,
    // 组级写「待核」：句子翻译、段落翻译的采分点是 Claude 拆的。单词、词组的答案就是原书的表，逐题写「已确认」
    ...pending,
    answerNote: '单词、词组的答案是原书单词表、词组表本身（已确认）。句子翻译的参考译文是原书的，拆成采分点是 Claude 做的；段落翻译的采分点是按原书中文译文逐句切的——这两类待人在后台确认。',
    sections: [
      { sectionId: `${gid}-s1`, type: '拼写单词', order: 1,
        questions: u.words.map(([en, zh]) => q({
          questionType: 'spell_word', ...book, stem: zh,
          items: [{ ord: 1, kind: 'BLANK', strategy: 'EXACT', answer: en, weight: 1 }],
          answer: en, knowledgePoints: ['词汇/单词拼写', unitTag] })) },
      { sectionId: `${gid}-s2`, type: '词组翻译', order: 2,
        questions: u.phrases.map(([en, zh]) => q({
          questionType: 'phrase_translate', ...book, stem: en,
          items: [{ ord: 1, kind: 'SCORE_POINT', strategy: 'AI_SCORE_POINTS', answer: `译出词组意思：${zh}`, weight: 1 }],
          knowledgePoints: ['翻译/词组英译汉', unitTag] })) },
      { sectionId: `${gid}-s3`, type: '句子翻译', order: 3,
        questions: u.sentences.map(([zh, en], i) => q({
          questionType: 'sentence_translate', stem: `把下面的句子译成英语：${zh}`,
          answerExplanation: `参考译文：${en}`,
          items: pts[i].map((p, j) => ({ ord: j + 1, kind: 'SCORE_POINT', strategy: 'AI_SCORE_POINTS', answer: p, weight: 1 })),
          knowledgePoints: ['翻译/句子汉译英', unitTag] })) },
      { sectionId: `${gid}-s4`, type: '段落翻译', order: 4,
        questions: u.paragraphs.map((p) => q({
          questionType: 'paragraph_translate', stem: `把下面的段落译成汉语：\n\n${p.en}`,
          answerExplanation: `参考译文：\n\n${p.zh}`,
          items: paragraphItems(p.zh),
          knowledgePoints: ['翻译/段落英译汉', unitTag] })) },
    ],
    parsingNotes: [],
  };
}

// ---------- 第四段考试样卷 2 ----------
// 翻译题的采分点是 Claude 拆的（教学重点里同一句的沿用那一句的，段落按参考译文逐句切），要人确认
const CLAUDE_POINTS = { answerState: '待核', answerSource: 'AI', answerReviewedBy: undefined, answerReviewedAt: undefined };
function test2Group(t, answers, points, orderKey) {
  const gid = 'pubeng-s4-test2';
  const a = answers.test2 || fail('answers.json 没有 test2');
  const meta = answerMeta(answers);
  const arr = (x, n, where) => {
    if (!Array.isArray(x) || x.length !== n) fail(`answers.json 的 test2.${where} 应当是 ${n} 项的数组`);
    return x;
  };
  const choiceKey = letters(a.choices, 25, 'answers.json 的 test2.choices');
  const readingKey = letters(a.reading, 10, 'answers.json 的 test2.reading');
  const fillKey = arr(a.passageFill, 10, 'passageFill');
  const box = t.passageFill.wordBox;
  const fillLetters = fillKey.map((w, i) => {
    const k = box.indexOf(String(w).trim());
    if (k < 0) fail(`answers.json 的 test2.passageFill 第 ${i + 1} 空是 ${JSON.stringify(w)}，不在词库里`);
    return LETTERS[k];
  });
  // 句子翻译的采分点：和教学重点里同一句的，直接沿用那一句的；其余在 translation-points.json 的 test2 里给
  const unitPts = new Map();
  for (const u of readJson('units.json').units) {
    u.sentences.forEach(([zh], i) => unitPts.set(zh.replace(/\s+/g, ''), points.sentences[u.id][i]));
  }
  const sentRef = arr(a.sentences, 5, 'sentences');
  const sentPts = t.sentences.items.map((zh, i) => unitPts.get(zh.replace(/\s+/g, '')) || points.test2?.[i]
    || fail(`样卷 2 句子翻译第 ${i + 1} 题既不在教学重点里，translation-points.json 的 test2[${i}] 也没给采分点`));
  let order = 0;
  const q = (extra) => ({ questionId: `${gid}-q${pad(++order)}`, order, status: '草稿', ...extra });
  return {
    groupId: gid, subjectCode: 'pubeng', courseCode: 'pubeng-main', groupKind: 'EXAM_PAPER', orderKey,
    label: '第四段考试样卷 2', sourceFile: '公共英语课程教学重点与考试样卷（扫描件）第 156–162 页',
    ...meta,
    sections: [
      { sectionId: `${gid}-s1`, type: '拼写单词', order: 1,
        questions: t.spelling.items.map((zh, i) => {
          const ans = arr(a.spelling, 20, 'spelling')[i];
          const [main, ...alt] = Array.isArray(ans) ? ans : [ans];
          return q({ questionType: 'spell_word', stem: zh, answer: main,
            items: [{ ord: 1, kind: 'BLANK', strategy: 'EXACT', answer: main, ...(alt.length ? { altAnswers: alt } : {}), weight: 1 }],
            knowledgePoints: ['词汇/单词拼写'] });
        }) },
      { sectionId: `${gid}-s2`, type: '词组翻译', order: 2,
        questions: t.phrases.items.map((en, i) => q({ questionType: 'phrase_translate', stem: en,
          items: [{ ord: 1, kind: 'SCORE_POINT', strategy: 'AI_SCORE_POINTS', answer: `译出词组意思：${arr(a.phrases, 10, 'phrases')[i]}`, weight: 1 }],
          knowledgePoints: ['翻译/词组英译汉'] })) },
      { sectionId: `${gid}-s3`, type: '选择填空', order: 3,
        questions: t.choices.items.map(([stem, ...opts], i) => q({ questionType: 'single_choice', stem,
          options: opts.map((o, j) => `${LETTERS[j]}. ${o}`), answer: choiceKey[i],
          knowledgePoints: [choiceTag('test2', i + 1, opts)] })) },
      { sectionId: `${gid}-s4`, type: '段落填空', order: 4, passageTitle: 'Going Home',
        passageText: `${t.passageFill.passage}\n\n词库：${box.map((w, j) => `${LETTERS[j]}. ${w}`).join('  ')}`,
        questions: fillLetters.map((L, i) => q({ questionType: 'single_choice',
          stem: `根据短文内容，从词库里为第 ${i + 1} 空选择最恰当的词。`,
          options: box.map((w, j) => `${LETTERS[j]}. ${w}`), answer: L, knowledgePoints: ['阅读/段落填空'] })) },
      ...t.reading.passages.map((p, k) => ({
        sectionId: `${gid}-s${5 + k}`, type: '阅读理解', order: 5 + k, passageText: p.text,
        questions: p.questions.map(([stem, ...opts], i) => q({ questionType: 'single_choice', stem,
          options: opts.map((o, j) => `${LETTERS[j]}. ${o}`), answer: readingKey[k * 5 + i],
          knowledgePoints: ['阅读/阅读理解'] })),
      })),
      { sectionId: `${gid}-s7`, type: '句子翻译', order: 7,
        // 参考译文是用户给的，拆成采分点是 Claude 做的：逐题标待核，组级的「已确认」不覆盖它
        questions: t.sentences.items.map((zh, i) => q({ questionType: 'sentence_translate', ...CLAUDE_POINTS,
          stem: `把下面的句子译成英语：${zh}`, answerExplanation: `参考译文：${sentRef[i]}`,
          items: sentPts[i].map((p, j) => ({ ord: j + 1, kind: 'SCORE_POINT', strategy: 'AI_SCORE_POINTS', answer: p, weight: 1 })),
          knowledgePoints: ['翻译/句子汉译英'] })) },
      { sectionId: `${gid}-s8`, type: '段落翻译', order: 8,
        questions: [q({ questionType: 'paragraph_translate', ...CLAUDE_POINTS, stem: `把下面的段落译成汉语：\n\n${t.paragraph.text}`,
          answerExplanation: `参考译文：\n\n${a.paragraph || fail('answers.json 的 test2.paragraph（段落翻译参考译文）是空的')}`,
          items: paragraphItems(a.paragraph), knowledgePoints: ['翻译/段落英译汉'] })] },
    ],
    parsingNotes: [],
  };
}

// ---------- 生成 ----------
const answersPath = path.join(SRC, 'answers.json');
const answers = fs.existsSync(answersPath) ? readJson('answers.json') : null;
const points = readJson('translation-points.json');
const groups = [];
const skipped = [];
readJson('units.json').units.forEach((u, i) => groups.push(unitGroup(u, points, 20 + i)));
if (answers) {
  groups.push(mcGroup({ set: 'mc-set1', groupId: 'pubeng-mc1', label: '选择题强化训练（一）', orderKey: 10, sourcePages: '121–131', answers }));
  groups.push(test2Group(readJson('sample-test2.json'), answers, points, 40));
  groups.push(mcGroup({ set: 'mc-set2', groupId: 'pubeng-mc2', label: '选择题强化训练（二）', orderKey: 50, sourcePages: '163–174', answers }));
} else {
  skipped.push('pubeng-mc1（选择题强化训练一）', 'pubeng-s4-test2（第四段考试样卷 2）', 'pubeng-mc2（选择题强化训练二）');
}

fs.mkdirSync(OUT, { recursive: true });
let bad = 0;
for (const g of groups) {
  const file = path.join(OUT, `${g.groupId}.json`);
  const text = `${JSON.stringify(g, null, 2)}\n`;
  const n = g.sections.reduce((s, x) => s + x.questions.length, 0);
  if (fs.existsSync(file)) {
    if (fs.readFileSync(file, 'utf8') === text) { console.log(`  一致  ${g.groupId}（${n} 题）`); continue; }
    bad++;
    console.log(`  !!    ${g.groupId}：盘上的文件和这次生成的不一样。导入过的题库文件不许改（CR-H4）；` +
      '还没合进 main 的话先删掉它再生成');
    continue;
  }
  if (CHECK) { bad++; console.log(`  缺    ${g.groupId}：盘上没有这个文件`); continue; }
  fs.writeFileSync(file, text);
  console.log(`  写入  ${g.groupId}（${n} 题）`);
}
for (const s of skipped) console.log(`  跳过  ${s}：source/answers.json 还没有，等用户提供答案`);
process.exit(bad ? 1 : 0);
