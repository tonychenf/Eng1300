// 识别实测的指标与体检（改进阶段 2 第二期）。纯 node。
// 期望值按构造现算：在标准答案上故意改 k 个字，编辑距离就该是 k、准确率就该是 1 − k / 字数——
// 不拿被测函数自己算出来的东西当期望。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { normalizeLine, normalizeText, align, parseQuestions, completeness, detection, agreement } from '../src/lib/ocr-metrics.js';
import { runChecks } from '../src/lib/ocr-checks.js';
import { evaluate, evaluateRef, matchReference, truthFor, TRUTH_PAGES, shortLine } from '../src/ocr-bench/evaluate.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};
const close = (a, b) => Math.abs(a - b) < 1e-9;

console.log('== 标准答案和转写稿一致（生成器 --check） ==');
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  let ok = true;
  try { execFileSync('node', [path.join(root, 'scripts/build-ocr-truth.mjs'), '--check'], { stdio: 'pipe' }); } catch { ok = false; }
  check('worker/src/ocr-bench/truth-data.js 是从转写稿现生成的', ok, true);
  const mc = TRUTH_PAGES.filter((p) => p.kind === 'mc');
  check('选择题 23 页，两组各 200 题、一题不漏不重',
    `${mc.length}/${mc.flatMap((p) => p.questions).length}/${new Set(mc.map((p) => p.label.slice(0, 9) + p.questions.join(','))).size}`, '23/400/23');
}

console.log('== 规整：版式不同、内容相同的两段规整后一样 ==');
{
  check('全角句点、长下划线、(A) 和 A) 视为同一种写法',
    normalizeLine('1．It pays to ________ as much （A） absorb'), normalizeLine('1. It pays to ____ as much A) absorb'));
  check('中文标点换成英文', normalizeLine('你好，世界。'), '你好,世界.');
  check('去掉页码 ·123·', normalizeLine('A) foo  · 123 ·'), 'A)foo');
  check('空白全去掉', normalizeLine('  a  b\tc '), 'abc');
}

console.log('== 对齐：编辑距离等于故意改的字数 ==');
{
  const t = 'Itpaysto_asmuchasyoucanfromreadingandlistening.A)absorbB)arrange';
  // 换掉 3 个位置的字（换成标准答案里不会有的字）
  const r = t.split('');
  for (const k of [2, 20, 40]) r[k] = '#';
  const a = align(r.join(''), t);
  check('换掉 3 个字：编辑距离 3、都是替换', `${a.dist}/${a.subs}/${a.ins}/${a.dels}`, '3/3/0/0');
  check('准确率 = 1 − 3 / 字数', close(1 - a.dist / t.length, 1 - 3 / t.length), true);
  check('出错位置标在那 3 个字上', [...a.errAt].map((x, i) => (x ? i : -1)).filter((i) => i >= 0).join(','), '2,20,40');
  const b = align(t.slice(0, 10) + t.slice(11) + 'Z', t);
  check('漏一个字、多一个字：编辑距离 2', `${b.dist}/${b.dels}/${b.ins}`, '2/1/1');
  // 半全局：标准答案两头多出来的部分不算错
  const core = t;
  const c = align(core.replace('absorb', 'absorh'), 'XXXXXXXX' + core + 'YYYYYY', { freeEnds: true });
  check('半全局：只算对上那一段里的错（1 个），对上的是中间那段', `${c.dist}/${c.tStart}/${c.tEnd}`, `1/8/${8 + core.length}`);
  check('识别结果为空：全局比对编辑距离 = 标准字数', align('', 'abc').dist, 3);
}

console.log('== 题目完整率 ==');
{
  const lines = ['1. first ____', 'A) a  B) b', 'C) c  D) d', '2. second', 'A) a  B) b  C) c', '3. third', 'A) x B) y C) z D) w'];
  const qs = parseQuestions(lines);
  check('认出 3 道题', qs.map((q) => q.no).join(','), '1,2,3');
  const c = completeness([1, 2, 3, 4], qs);
  check('第 2 题缺 D、第 4 题没认出：2/4', `${c.ok}/${c.total}/${c.missing.join(',')}`, '2/4/2,4');
}

console.log('== 体检规则 ==');
{
  const txt = ['· 121 ·', '1. aaa', 'A) a B) b C) c D) d', '2. bbb', 'A) a B) b C) c', '4. ddd', 'A) a B) b C) c D) d', '5. e�e', 'A) a B) b C) c D) d'].join('\n');
  const f = runChecks(txt, { expectedPage: 122, expectOptions: true });
  const by = (rule) => f.filter((x) => x.rule === rule).map((x) => x.line).join(',');
  check('页码对不上（印的是 121，标的是 122）', by('page'), '0');
  check('题号从 2 跳到 4', by('number'), '5');
  check('第 2 题选项不齐：这道题的两行都标上', by('options'), '3,4');
  check('乱码', by('garbled'), '7');
  check('字数偏少：整页都标出来', runChecks('1. a\nA) a', { minChars: 100 }).filter((x) => x.rule === 'short').length, 2);
  check('中位数线：页数够才判', `${shortLine([1000, 1200, 800])}/${shortLine([1000, 1200])}`, '500/0');
}

console.log('== 检出率、误报率 ==');
{
  const d = detection([1, 2, 3, 4], [2, 3, 9]);
  check('4 行有错、标了 3 行、对上 2 行', `${d.caught}/${d.missed}/${d.falsePos}`, '2/2/1');
  check('检出率 2/4、误报率 1/3', `${d.detectRate}/${close(d.falsePosRate, 1 / 3)}`, '0.5/true');
}

console.log('== 整页评估：标准答案原样当识别结果 ==');
{
  // 每一页的标准答案原样交上去：准确率 100%、完整率 100%、体检一处都不报（不报假警）
  let perfect = 0, flagged = 0;
  for (const p of TRUTH_PAGES) {
    const e = evaluate(truthFor(p.page).kind === 'doc' ? truthFor(p.page).text : truthFor(p.page).text, p.page);
    if (close(e.accuracy, 1) && (e.completeness == null || e.completeness.rate === 1)) perfect++;
    if (e.flags.length) flagged++;
  }
  check(`${TRUTH_PAGES.length} 页的标准答案原样交上去，全都 100%`, perfect, TRUTH_PAGES.length);
  check('体检对标准答案一处都不报', flagged, 0);
  // 第 121 页改 5 个字、删掉第 17 题的 D 选项那一段
  const t = truthFor(121).text;
  const lines = t.split('\n');
  const broken = lines.map((ln, i) => (i === 3 ? ln.replace(/[a-z]/g, (ch, k) => (k < 30 && ch === 'e' ? '3' : ch)) : ln));
  const nE = (lines[3].slice(0, 30).match(/e/g) || []).length;
  const last = broken.length - 1;
  broken[last] = broken[last].replace(/\s+D\).*$/, '');
  const e = evaluate(broken.join('\n'), 121);
  check(`改了 ${nE} 个字、删了一个选项：准确率 < 100%，完整率 ${truthFor(121).questions.length - 1}/${truthFor(121).questions.length}`,
    `${e.accuracy < 1}/${e.completeness.ok}/${e.completeness.total}`, `true/${truthFor(121).questions.length - 1}/${truthFor(121).questions.length}`);
  check('缺选项那一行体检标出来了、出错的行里有它', `${e.flags.some((f) => f.rule === 'options')}/${e.detection.caught >= 1}`, 'true/true');
  check('没有转写稿的页：只给体检，不给准确率', `${'accuracy' in evaluate('x', 132)}/${evaluate('x', 132).unavailable ? 1 : 0}`, 'false/1');
}

console.log('== 不标页码：识别结果自己去转写稿里找是哪一页 ==');
{
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  // 期望的那一份直接从页面属性写出来（选择题页是它自己，教学重点、样卷是它那一篇），不拿被测函数的查表
  const want = (p) => (p.kind === 'mc' ? `page-${p.page}` : p.doc);
  const corrupt = (t, every) => [...t].map((c, i) => (i % every === 0 && /[a-z]/.test(c) ? '#' : c)).join('');
  let hit = 0;
  const miss = [];
  for (const p of TRUTH_PAGES) {
    const t = truthFor(p.page).text;
    // 教学重点、样卷一篇跨几页：照片只拍到其中一页，取中间三分之一当这一页
    const one = p.kind === 'mc' ? t : t.slice(Math.floor(t.length / 3), Math.floor((2 * t.length) / 3));
    const m = matchReference(corrupt(one, 10));
    if (m && m.ref.key === want(p)) hit++; else miss.push(`${p.page}→${m?.ref.key ?? '没对上'}`);
  }
  check(`${TRUTH_PAGES.length} 页各改掉十分之一的字母，都找回了自己那一页（那一篇）`, `${hit}${miss.length ? ` 漏：${miss.join(' ')}` : ''}`, `${TRUTH_PAGES.length}`);
  // 反面：别的英语材料、别的学科，一页也不许错配（错配了就拿一份错的标准答案去算准确率）
  let n = 0;
  const wrong = [];
  for (const subj of ['english', 'biochem']) {
    const dir = path.join(root, 'data/subjects', subj, 'groups');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const strs = [];
      JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'), (k, v) => { if (typeof v === 'string' && /[a-zA-Z一-龥]{2}/.test(v)) strs.push(v); return v; });
      const page = strs.join('\n').slice(0, 2500);
      n++;
      const m = matchReference(page);
      if (m) wrong.push(`${f}→${m.ref.key}`);
    }
  }
  check(`英语、生化题库各章取一页长的题面（${n} 份），一份都不错配到公共英语转写稿`, wrong.join(' ') || '无', '无');
  check('太短（不到 30 字）的不去找', matchReference('1. It pays to'), null);
  // 没对上：只给体检；像选择题的照样按"选项要齐"查
  const free = ['1. 下列哪种氨基酸属于碱性氨基酸？', 'A. 赖氨酸 B. 谷氨酸 C. 丙氨酸 D. 甘氨酸', '2. 维系蛋白质一级结构的化学键是',
    'A. 肽键 B. 氢键 C. 二硫键', '3. 蛋白质变性是由于', 'A. 一级结构改变 B. 空间构象破坏 C. 辅基脱落 D. 蛋白质水解'].join('\n');
  const e = evaluateRef(free, null);
  check('对不上转写稿：不给准确率，说清只能对着原图看', `${'accuracy' in e}/${/原图/.test(e.unavailable)}`, 'false/true');
  check('对不上转写稿也照样体检：像选择题，第 2 题缺 D 那两行标出来', e.flags.filter((f) => f.rule === 'options').map((f) => f.line).join(','), '2,3');
  check('页码检查认一篇跨的几页：印 ·134· 对上第 133–134 页那篇不报', runChecks('· 134 ·\nx', { expectedPage: [133, 134] }).length, 0);
  check('印 ·135· 就报', runChecks('· 135 ·\nx', { expectedPage: [133, 134] }).map((f) => f.rule).join(), 'page');
}

console.log('== 几个模型之间对不对得上（没有转写稿时看哪里） ==');
{
  const A = ['第一行 蛋白质的一级结构', '第二行 是指多肽链中氨基酸的排列顺序', '第三行 维系一级结构的化学键主要是肽键'].join('\n');
  // 第 2 行换掉 1 个字：两份里都只有那一个字对不上，标在第 2 行（行号 1）
  const B = A.replace('多肽链', '多呔链');
  const n = normalizeText(A).s.length;
  const [a, b] = agreement([A, B]);
  check('换掉 1 个字：两份都只标第 2 行', `${a.lines.join()}|${b.lines.join()}`, '1|1');
  check('一致率 = 1 − 1 / 字数', `${close(a.rate, 1 - 1 / n)}/${close(b.rate, 1 - 1 / n)}`, 'true/true');
  // 换行不一样、内容一样：不算对不上
  const C = A.replace('\n第二行', '第二行');
  check('只是换行不一样：一致率 100%、不标', agreement([A, C]).map((x) => `${x.rate}/${x.lines.length}`).join(' '), '1/0 1/0');
  // 三份里只有一份漏了一行：漏的那份不标（它没有那几个字），另两份把那一行标出来
  const D = A.split('\n').filter((_, i) => i !== 2).join('\n');
  const [x, y, z] = agreement([A, A, D]);
  check('三份里一份漏了第 3 行：另两份标第 3 行，漏的那份没东西可标', `${x.lines.join()}|${y.lines.join()}|${z.lines.join()}`, '2|2|');
  check('只有一份：没法比，一致率是空', agreement([A])[0].rate, null);
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
