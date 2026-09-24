// 富媒体题干单测（验收 G2、G3、G5，以及 G1/G4 的数据侧）。
//
// 纯 node。三件事：
//   ① 标记切分不能误伤现有题库——英语真题原文里就有 `$300 per month` 和
//      `$0.79, $0.99 and $1.49`，按"两个 $ 之间是公式"切会当场把原文切烂。
//      所以这里拿**真实的 1020 道题**跑一遍，断言一个公式都不该切出来。
//   ② 题目契约（alt 必填、引用的 key 必须存在）要真的拒，并且说清楚是哪道题。
//   ③ 判分不解析 LaTeX——这是有意的，所以要有一条断言钉住它，
//      免得哪天有人"顺手"加个等价判断。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tokenize, hasMarkup } from '../../web/src/lib/rich-text.js';
import { validateAssets, stemForAi, assetRefsIn } from '../src/lib/stem-assets.js';
import { gradeQuestion } from '../src/lib/grade.js';
import { resolveNormalizers } from '../src/normalizers/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};
const throws = (desc, fn, wantCode) => {
  let code = null, msg = '';
  try { fn(); } catch (e) { code = e.code || '（没有 code）'; msg = e.message; }
  if (code === wantCode) { pass++; return msg; }
  fail++; console.log(`  FAIL ${desc} (期望抛 ${wantCode}, 实际 ${code})`);
  return msg;
};
const types = (s) => tokenize(s).map((t) => t.type).join(',');

console.log('== 标记切分 ==');
{
  check('普通文本一段不切', types('这是一道普通题'), 'text');
  check('图片引用切出来', types('见 ![fig1] 图'), 'text,image,text');
  check('图片 key 取对', (tokenize('见 ![fig1] 图')[1] || {}).key, 'fig1');
  check('行内公式切出来', types('化简 $x^2$ 得'), 'text,math,text');
  check('公式内容不带界符', (tokenize('化简 $x^2$ 得')[1] || {}).value, 'x^2');
  check('块级公式切出来', types('推导：$$a=b$$'), 'text,math');
  check('块级公式标成 display', (tokenize('推导：$$a=b$$')[1] || {}).display, true);
  check('行内公式不是 display', (tokenize('化简 $x^2$ 得')[1] || {}).display, false);
  check('中括号文本不当成图片', types('数组 [fig1] 不是图'), 'text');
  check('key 里有空格就不是图片引用', types('![fig 1]'), 'text');
}

console.log('== 美元号不能误伤真实题库 ==');
{
  // 这几条直接取自英语真题的阅读原文
  check('$300 per month … $400 per month 不是公式',
    types('you might pay $300 per month for the car. you would pay about $400 per month'), 'text');
  check('$0.79, $0.99 and $1.49 不是公式',
    types('categories: $0.79, $0.99 and $1.49. When he saw'), 'text');
  check('almost $1 million … more than $2 million 不是公式',
    types('earn almost $1 million more and more than $2 million in their lifetime'), 'text');
  check('开界符后面是空白就不开公式', types('花了 $ 300 块'), 'text');
  check('闭界符后面紧跟数字不闭合', types('从 $5-$10 不等'), 'text');
  check('公式不许跨行', types('上面 $a\n下面 b$ 完'), 'text');
  // 真正的公式还是要切出来——否则上面那几条只要"永远不切"就能全过
  check('紧凑写法的公式照常切', types('设 $a+b$ 为常数'), 'text,math,text');
}

console.log('== 拿真实题库跑一遍：一个标记都不该切出来 ==');
{
  const dir = path.join(root, 'data', 'subjects', 'english', 'groups');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  check('真的读到了 20 套卷子（否则下面是空断言）', files.length, 20);
  let texts = 0;
  const offenders = [];
  for (const f of files) {
    const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    for (const s of d.sections || []) {
      for (const t of [s.passageText, s.passageTitle, s.writingPrompt]) {
        if (!t) continue;
        texts++;
        if (hasMarkup(t)) offenders.push(`${f} 篇章 ${s.sectionId}`);
      }
      for (const q of s.questions || []) {
        for (const t of [q.stem, q.answer, q.answerExplanation, ...(q.options || [])]) {
          if (!t) continue;
          texts++;
          if (hasMarkup(String(t))) offenders.push(`${f} ${q.questionId}`);
        }
      }
    }
  }
  check('扫过的文本不止一点点', texts > 3000, true);
  check('没有一段真实文本被当成公式或图片', offenders.slice(0, 3).join('；'), '');
}

console.log('== 题目契约：alt 必填、引用的 key 必须存在（G2）==');
{
  const okAsset = { key: 'fig1', kind: 'IMAGE', path: 'biochem/ch02/f.png', alt: '腺嘌呤与胸腺嘧啶配对' };
  const q = (over = {}) => ({ questionId: 'Q1', stem: '见 ![fig1]', ...over });
  check('合格的题没有问题', validateAssets(q(), [okAsset]).length, 0);

  const noAlt = validateAssets(q(), [{ ...okAsset, alt: '' }]);
  check('alt 空着要报', noAlt.length, 1);
  check('报错说清楚为什么 alt 必填', (noAlt[0] || '').includes('AI 看不到图'), true);
  check('alt 写成"图1"等于没写', validateAssets(q(), [{ ...okAsset, alt: '图1' }]).length, 1);
  check('alt 写成 fig1 也不行', validateAssets(q(), [{ ...okAsset, alt: 'fig1' }]).length, 1);
  check('AUDIO 不要求 alt', validateAssets(
    { questionId: 'Q1', stem: '听 ![au1]' },
    [{ key: 'au1', kind: 'AUDIO', path: 'x/a.mp3' }]).length, 0);

  const badRef = validateAssets(q({ stem: '见 ![nosuch]' }), [okAsset]);
  // 一头是"引用了没声明的"，另一头是"声明了没人引用"，两条一起报才看得出是拼错了
  check('引用不存在的 key 要报', badRef.length, 2);
  check('报错里点名是哪个 key', (badRef[0] || '').includes('nosuch'), true);
  check('并且指出声明了的是哪个', (badRef[1] || '').includes('fig1'), true);

  check('选项里的引用也算数', validateAssets(
    { questionId: 'Q1', stem: '看图选择', options: ['A. ![fig1]', 'B. 无'] }, [okAsset]).length, 0);
  check('逐项答案里的引用也算数', validateAssets(
    { questionId: 'Q1', stem: '填空', itemAnswers: ['![fig1]'] }, [okAsset]).length, 0);

  // path 会被拼成 URL，既是数据校验也是一道边界
  for (const bad of ['/etc/passwd', '../../secret.png', 'a\\b.png', '']) {
    check(`路径 ${JSON.stringify(bad)} 被拒`,
      validateAssets(q(), [{ ...okAsset, path: bad }]).some((p) => p.includes('路径')), true);
  }
  check('认不出的 kind 被拒',
    validateAssets(q(), [{ ...okAsset, kind: 'VIDEO' }]).some((p) => p.includes('类型')), true);
  check('key 重复被拒',
    validateAssets(q(), [okAsset, { ...okAsset }]).some((p) => p.includes('重复')), true);
  // fileExists 是种子阶段才有的那条
  check('文件不在盘上被拒',
    validateAssets(q(), [okAsset], { fileExists: () => false }).some((p) => p.includes('不在盘上')), true);
  check('文件在盘上就通过',
    validateAssets(q(), [okAsset], { fileExists: () => true }).length, 0);
}

console.log('== 喂 AI 前的替换（G3）==');
{
  const assets = [{ key: 'fig1', alt: '腺嘌呤与胸腺嘧啶之间形成两个氢键' }];
  const out = stemForAi('下图 ![fig1] 中氢键数目？公式 $\\frac{a}{b}$ 保留原样。', assets);
  check('图片引用换成了 [图：alt]', out.includes('[图：腺嘌呤与胸腺嘧啶之间形成两个氢键]'), true);
  check('不是原样的 ![fig1]', out.includes('![fig1]'), false);
  check('也不是删掉——alt 那句话在', out.includes('腺嘌呤'), true);
  check('公式原样保留（模型认识 LaTeX）', out.includes('$\\frac{a}{b}$'), true);
  check('没有图的题原样返回', stemForAi('普通题干', []), '普通题干');
  check('assets 没传也不影响没有图的题', stemForAi('普通题干'), '普通题干');
  // 漏传 assets 的调用方要当场炸，不能把残缺题干发给模型
  throws('题里有图却没传 assets 时抛错', () => stemForAi('见 ![fig1]', []), 'asset_missing');
  throws('资源没有 alt 时抛错', () => stemForAi('见 ![fig1]', [{ key: 'fig1', alt: '' }]), 'asset_without_alt');
  check('assetRefsIn 去重', assetRefsIn('![a] ![b] ![a]').join(','), 'a,b');
}

console.log('== 判分不解析 LaTeX（G5）==');
{
  // 这条是**有意为之**，不是没做完：半吊子的符号等价比没有更危险。
  // 需要公式等价的题走 NUMERIC / AI_SCORE_POINTS / MANUAL 三条出口（§6.4.6）。
  const t = {
    code: 'T', name: '构造', isObjective: true, inPractice: true, needsAi: false,
    aiReviewOnMiss: false, widget: 'text', answerShape: 'TEXT_SHORT',
    gradingStrategy: 'EXACT', normalizerNames: [], normalizers: resolveNormalizers([], 'x'),
  };
  const pack = {
    code: 'test', rubric: { grading: { partialCredit: true, caseSensitive: false },
      essay: {}, mastery: { correctThreshold: 1 } },
    grading: { partialCredit: true, caseSensitive: false },
    types: new Map([['T', t]]), typeOf: () => t,
  };
  const q = { question_id: 'F1', question_type: 'T', answer: '$0.5$' };
  check('$\\frac{1}{2}$ 不等于 $0.5$', gradeQuestion(pack, q, '$\\frac{1}{2}$', 1).isCorrect, 0);
  check('一模一样的写法才算对', gradeQuestion(pack, q, '$0.5$', 1).isCorrect, 1);
  // 归一化只做首尾标点折叠，所以去掉界符的 0.5 仍然算对——这不是在解析公式
  check('去掉界符的 0.5 算对（基础折叠去首尾标点）', gradeQuestion(pack, q, '0.5', 1).isCorrect, 1);
  check('0.50 不等于 0.5（没有数值化）', gradeQuestion(pack, q, '0.50', 1).isCorrect, 0);
}

console.log('== 种子生成阶段拒掉不合契约的题（G2 端到端）==');
{
  const run = (dir, out) => {
    // 先清干净。留着上一轮的产物，"失败时不产出 SQL"那条就会看到别人留下的文件——
    // 证伪跑完之后这条曾经莫名其妙地红过一次，就是这么来的。
    fs.rmSync(out, { recursive: true, force: true });
    try {
      const stdout = execFileSync('node', ['scripts/build-seed-sql.mjs', out], {
        cwd: root, encoding: 'utf8', env: { ...process.env, SEED_SUBJECT_DIR: dir },
      });
      return { code: 0, text: stdout };
    } catch (e) {
      return { code: e.status, text: String(e.stdout || '') + String(e.stderr || '') };
    }
  };
  const good = run('worker/test/fixtures/n5b-good', '/tmp/n5b-seed-good');
  check('合格的构造卷生成成功', good.code, 0);
  check('并且数出了 1 个题目资源', /1 个题目资源/.test(good.text), true);
  // 文件名带学科前缀（种子生成器一次跑一个学科，不加前缀两科会互相覆盖）。
  // 这里不写死前缀，从目录里找——写死的话改一次命名规则就要回来改两处路径，
  // 而改漏的表现是"生成出了那套卷子的 SQL"变红，指向的却不是真正的问题。
  const sqlPath = fs.readdirSync('/tmp/n5b-seed-good')
    .filter((f) => f.endsWith('fixture-2026-01.sql'))
    .map((f) => `/tmp/n5b-seed-good/${f}`)[0] || '/tmp/n5b-seed-good/缺';
  check('生成出了那套卷子的 SQL', fs.existsSync(sqlPath), true);
  const sql = fs.existsSync(sqlPath) ? fs.readFileSync(sqlPath, 'utf8') : '';
  check('资源写进了 question_assets', sql.includes('INSERT INTO question_assets'), true);
  check('alt 一起入库', sql.includes('腺嘌呤与胸腺嘧啶之间形成两个氢键'), true);
  check('清题时连资源一起清', sql.includes('DELETE FROM question_assets'), true);
  // G10：图片本身不进 D1，只有元数据行
  check('SQL 里没有图片的字节', sql.includes('iVBORw0KGgo'), false);
  check('SQL 里存的是相对路径', sql.includes("'fixture/ch01/fig1.png'"), true);

  const bad = run('worker/test/fixtures/n5b-bad', '/tmp/n5b-seed-bad');
  check('写坏的构造卷生成失败', bad.code, 1);
  check('逐条打印题号：alt 缺失那道', bad.text.includes('fx-bad-alt'), true);
  check('逐条打印题号：引用错那道', bad.text.includes('fx-bad-ref'), true);
  check('失败时不产出 SQL',
    fs.existsSync('/tmp/n5b-seed-bad')
      && fs.readdirSync('/tmp/n5b-seed-bad').some((f) => f.endsWith('fixture-2026-02.sql')), false);
}

console.log(`== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
