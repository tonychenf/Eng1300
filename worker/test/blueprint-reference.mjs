// **蓝本实现的冻结副本。不要跟着 src/ 一起改。**
//
// 用途：N4 的行为一致性验证（需求文档 §13.1 的前三条）要证明"加了学科层与能力包
// 之后，英语的判分、作文加权、掌握度分档与蓝本完全一致"。证明这件事需要一个
// **与新实现不同源**的参照物——拿新实现去对新实现是恒等式，证明不了任何东西。
//
// 所以这里原样保留蓝本 M5 时期的三段逻辑：
//   grade.js   canonWord / canonChoice / gradeQuestion（英语判分，题型写死）
//   tutor.js   作文五维加权（权重写死在合成那一行里）
//   mastery.js masteryTier / tagWeight（阈值与权重写死）
//
// 它们现在在 src/ 里已经被拆成"通用骨架 + 能力包配置"。这个文件是那之前的样子。
// **改 src/ 时不要来同步这个文件**：一同步，这组对比就退化成恒等式，
// 而它唯一的价值就是不同源。真要改这里，只有一种情况：发现抄错了。
//
// 用法（给 shell 测试调）：
//   node blueprint-reference.mjs grade   <题型> <标准答案> <学生答案> <分值>
//   node blueprint-reference.mjs essay   <content> <language> <vocabulary> <coherence> <length>
//   node blueprint-reference.mjs tier    <correct> <wrong> <streak> <lastResult>
//   node blueprint-reference.mjs weight  <correct> <wrong> <streak> <lastResult>

// ───────── 蓝本 grade.js ─────────
const SPELLING_PAIRS = [
  ['travelled','traveled'],['travelling','traveling'],['traveller','traveler'],
  ['cancelled','canceled'],['cancelling','canceling'],
  ['labelled','labeled'],['labelling','labeling'],
  ['modelled','modeled'],['modelling','modeling'],
  ['signalled','signaled'],['signalling','signaling'],
  ['marvellous','marvelous'],['skilful','skillful'],['fulfil','fulfill'],
  ['practise','practice'],['licence','license'],['defence','defense'],
  ['offence','offense'],['pretence','pretense'],
  ['grey','gray'],['programme','program'],['storey','story'],
  ['judgement','judgment'],['ageing','aging'],['enrolment','enrollment'],
  ['instalment','installment'],['fulfilment','fulfillment'],
  ['analyse','analyze'],['paralyse','paralyze'],
];
const PAIR_MAP = new Map(SPELLING_PAIRS);
const OUR_KEEP = new Set(['four','hour','your','tour','pour','sour','flour','our','dour']);

function canonWord(raw) {
  let w = String(raw ?? '').trim().toLowerCase();
  if (!w) return '';
  w = w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
  if (PAIR_MAP.has(w)) return PAIR_MAP.get(w);
  w = w.replace(/isation$/,'ization').replace(/isations$/,'izations')
       .replace(/ising$/,'izing').replace(/ised$/,'ized')
       .replace(/iser$/,'izer').replace(/isers$/,'izers')
       .replace(/ise$/,'ize').replace(/ises$/,'izes');
  if (!OUR_KEEP.has(w)) w = w.replace(/our$/,'or').replace(/ours$/,'ors');
  return w.replace(/tre$/,'ter').replace(/tres$/,'ters');
}
function canonChoice(raw) {
  return String(raw ?? '').trim().toUpperCase().replace(/[^A-Z]/g, '');
}

// 蓝本这里的题型是写死的三个分支。N4 把英语的 fill_blank_transform 改名成
// fill_text，所以下面两个名字都认——改的是名字，不是行为，这一点正是要证明的。
function gradeQuestion(type, correctAnswer, userAnswer, scorePerQuestion) {
  if (type === 'essay') return { isCorrect: null, score: null, needsAiReview: true };
  const answered = String(userAnswer ?? '').trim();
  if (!answered) return { isCorrect: 0, score: 0, needsAiReview: false };
  if (type === 'single_choice') {
    const ok = canonChoice(answered) === canonChoice(correctAnswer);
    return { isCorrect: ok ? 1 : 0, score: ok ? scorePerQuestion : 0, needsAiReview: false };
  }
  if (type !== 'fill_blank_transform' && type !== 'fill_text') {
    throw new Error(`蓝本只认识 single_choice / fill_blank_transform(fill_text) / essay，收到 ${type}`);
  }
  const ok = canonWord(answered) === canonWord(correctAnswer);
  return { isCorrect: ok ? 1 : 0, score: ok ? scorePerQuestion : 0, needsAiReview: !ok };
}

// ───────── 蓝本 tutor.js 的作文加权 ─────────
// 权重与满分当时写死在合成总分那一行里
function essayTotal({ content, language, vocabulary, coherence, length }) {
  const weighted = content * 0.30 + language * 0.25 + vocabulary * 0.15
                 + coherence * 0.20 + length * 0.10;
  return Math.round((weighted / 6) * 30 * 10) / 10;
}

// ───────── 蓝本 mastery.js ─────────
function masteryTier(row) {
  const total = (row.correct_count || 0) + (row.wrong_count || 0);
  if (total === 0) return '未测';
  if (row.last_result === 'wrong') return '薄弱';
  if (total >= 3 && (row.consecutive_correct || 0) >= 3) return '已掌握';
  const recentRate = total ? (row.correct_count || 0) / total : 0;
  if (recentRate < 0.5) return '薄弱';
  return '待巩固';
}
function tagWeight(row) {
  if (!row) return 2.0;
  const total = (row.correct_count || 0) + (row.wrong_count || 0);
  if (total === 0) return 2.0;
  if (row.last_result === 'wrong') return 5.0;
  const streak = row.consecutive_correct || 0;
  if (streak <= 1) return 2.0;
  if (streak === 2) return 1.0;
  return 0.3;
}

// 批量比对：从 stdin 读 TSV，每行 题型<TAB>标准答案<TAB>学生答案<TAB>分值<TAB>系统判的对错
// 逐行用蓝本实现重算，只打印对不上的行。一次 node 启动跑完整卷，比逐题起进程快得多。
function batchCompare(text) {
  let n = 0, bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [type, answer, userAnswer, spq, actual] = line.split('\t');
    n++;
    const want = gradeQuestion(type, answer, userAnswer, Number(spq)).isCorrect;
    // 系统里 NULL（作文待批改）在 SQL 导出时是空串
    const got = actual === '' || actual === 'null' ? null : Number(actual);
    if (want !== got) {
      bad++;
      console.log(`不一致｜题型=${type} 标准答案=${JSON.stringify(answer)} `
        + `学生答案=${JSON.stringify(userAnswer)} 蓝本判=${want} 系统判=${got}`);
    }
  }
  console.log(`比对 ${n} 行，不一致 ${bad} 行`);
  return bad;
}

// ───────── CLI ─────────
const [, , cmd, ...a] = process.argv;
const num = (x) => Number(x);
const row = () => ({
  correct_count: num(a[0]), wrong_count: num(a[1]),
  consecutive_correct: num(a[2]), last_result: a[3] === 'null' ? null : a[3],
});
switch (cmd) {
  case 'grade':  process.stdout.write(String(gradeQuestion(a[0], a[1], a[2], num(a[3])).isCorrect)); break;
  case 'score':  process.stdout.write(String(gradeQuestion(a[0], a[1], a[2], num(a[3])).score)); break;
  case 'essay':  process.stdout.write(String(essayTotal({
                   content: num(a[0]), language: num(a[1]), vocabulary: num(a[2]),
                   coherence: num(a[3]), length: num(a[4]) }))); break;
  case 'tier':   process.stdout.write(masteryTier(row())); break;
  case 'weight': process.stdout.write(String(tagWeight(row()))); break;
  case 'batch': {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => process.exit(batchCompare(buf) === 0 ? 0 : 1));
    break;
  }
  default: console.error('用法见文件头'); process.exit(2);
}
