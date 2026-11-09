// 识别实测的指标与体检（改进阶段 2 第二期）。纯 node。
// 期望值按构造现算：在标准答案上故意改 k 个字，编辑距离就该是 k、准确率就该是 1 − k / 字数——
// 不拿被测函数自己算出来的东西当期望。
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeLine, normalizeText, align, parseQuestions, completeness, detection } from '../src/lib/ocr-metrics.js';
import { runChecks } from '../src/lib/ocr-checks.js';
import { evaluate, truthFor, TRUTH_PAGES, shortLine } from '../src/ocr-bench/evaluate.js';

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

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
