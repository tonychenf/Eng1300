// 公共英语学员端的浏览器检查（2026-11-07），由 ui-pubeng.sh 准备好数据后调用。
//
// 断"看得见、点得动"：每种题型在练习里打开、作答、看反馈；模考作答页每个部分的控件对不对、能不能填完交卷；
// 报告里翻译题按采分点批完、总分对得上。等不到的元素只让那几条红，不抛错。
import { chromium } from 'playwright';
import { chromePath } from './lib/chrome.mjs';

const BASE = process.env.UI_BASE;
const CHROME = chromePath();
const USER = process.env.UI_USER;
const PASS = process.env.UI_PASS;
const PRACTICE = JSON.parse(process.env.UI_PRACTICE);
const KEYS = JSON.parse(process.env.UI_KEYS);
const EXAMS = JSON.parse(process.env.UI_EXAMS);
const N_SPELL = Number(process.env.UI_N_SPELL);
const N_LONG = Number(process.env.UI_N_LONG);
const TOTAL = Number(process.env.UI_TOTAL);

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};
const shows = (loc, timeout = 10000) =>
  loc.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = async (page, width, name) => {
  if (process.env.UI_SHOTS && width === 390) await page.screenshot({ path: `${process.env.UI_SHOTS}/${name}.png`, fullPage: true });
};
// 按题干认题：去空白前 24 个字（ui-pubeng.sh 用同一个口径建的键）
const keyOf = async (card) => {
  const raw = (await card.locator('.q-stem').innerText()).replace(/\s+/g, '');
  return Object.keys(KEYS).find((k) => raw.startsWith(k)) || null;
};
const fontPx = (loc) => loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

const browser = await chromium.launch({ executablePath: CHROME });
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];

try {
  for (const [i, [width, height, label]] of WIDTHS.entries()) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/app\/pubeng/, { timeout: 15000 });

    const openPractice = async (type) => {
      await page.goto(`${BASE}/app/pubeng/practice/${PRACTICE[type][i]}/run`, { waitUntil: 'networkidle' });
      const card = page.locator('.q-card').first();
      const ok = await shows(card);
      check(`${label}｜练习「${type}」出题了、题卡看得见`, ok, true);
      return ok ? card : null;
    };

    // ── 拼写单词：给中文写英文。故意写错，看给不给标准答案 ──
    {
      const card = await openPractice('拼写单词');
      if (card) {
        const key = await keyOf(card);
        const box = card.locator('input.input').first();
        check(`${label}｜拼写：一个看得见的输入框（认出了题：${key ? '是' : '否'}）`, await shows(box), true);
        check(`${label}｜拼写：输入框字号不小于 16px（iOS 不自动放大）`, (await fontPx(box)) >= 16, true);
        await box.fill('zzzz');
        await page.click('button:has-text("提交答案")');
        check(`${label}｜拼写写错：反馈"答错了"`, await shows(page.locator('text=答错了')), true);
        const want = key ? KEYS[key].answer : '（没认出题）';
        check(`${label}｜拼写写错：看得见标准答案 ${want}`,
          await shows(page.locator(`text=${want}`).first(), 3000), true);
        // P1-X3：以前同一屏出现三次、单空题还标着"第 1 空"
        const bodyText = await page.locator('body').innerText();
        check(`${label}｜拼写写错：标准答案只出现一次`, bodyText.split(want).length - 1, 1);
        check(`${label}｜拼写：单空题不标"第 1 空"`, bodyText.includes('第 1 空'), false);
        await shot(page, width, '1-spell-wrong');
      }
    }

    // ── 三种翻译：交上去当场 AI 批（改进阶段 2 P1-G1），看得见得分、逐点理由、参考译文 ──
    for (const [type, text, wantRef, wantTag] of [
      ['词组翻译', '【全对】就……而言', false, 'input'],
      ['句子翻译', '【全对】This is my translation of the sentence.', true, 'textarea'],
      ['段落翻译', '【全对】这是我的译文。', true, 'textarea'],
    ]) {
      const card = await openPractice(type);
      if (!card) continue;
      const box = card.locator('textarea, input.input').first();
      const boxShown = await shows(box);
      check(`${label}｜${type}：有一个看得见的作答框`, boxShown, true);
      if (!boxShown) continue;
      // P1-X6：控件照题型声明——词组翻译单行，句子、段落多行
      check(`${label}｜${type}：作答框是 ${wantTag}`, await box.evaluate((el) => el.tagName.toLowerCase()), wantTag);
      check(`${label}｜${type}：作答框字号不小于 16px`, (await fontPx(box)) >= 16, true);
      if (type === '段落翻译') {
        const stem = await card.locator('.q-stem').innerText();
        check(`${label}｜段落翻译：英文原文整段显示在题干里`, stem.length > 200, true);
      }
      await box.fill(text);
      await page.click('button:has-text("提交答案")');
      const graded = page.locator('.ai-graded');
      check(`${label}｜${type}：交上去当场批了（看得见得分卡）`, await shows(graded, 20000), true);
      check(`${label}｜${type}：答对了、不再是"练习不判分"`,
        `${await graded.locator('.badge.ok', { hasText: '答对了' }).isVisible().catch(() => false)}/${await page.locator('text=练习不判分').count()}`, 'true/0');
      check(`${label}｜${type}：写着答到几个采分点`, /采分点答到 \d+ 个，共 \d+ 个/.test(await page.locator('[data-testid="practice-ai-score"]').innerText().catch(() => '')), true);
      check(`${label}｜${type}：逐点理由看得见`, await shows(page.locator('.point-reason').first(), 3000), true);
      if (wantRef) check(`${label}｜${type}：看得见参考译文`, await shows(page.locator('text=参考译文').first(), 3000), true);
      if (width === 390) check(`手机｜${type}练习页没有横向滚动`, await noOverflow(page), true);
      await shot(page, width, `2-${type}`);
    }

    // ── AI 没批出来：不显示 0 分，给采分点自评、能再试一次（替身【照抄】= 模型抄回示例） ──
    {
      const card = await openPractice('词组翻译');
      if (card) {
        await card.locator('input.input').first().fill('【照抄】随便写');
        await page.click('button:has-text("提交答案")');
        const sc = page.locator('.self-check');
        check(`${label}｜没批出来：显示"这次没批出来"和采分点`,
          `${await shows(sc, 20000) && await sc.locator('.badge', { hasText: '这次没批出来' }).isVisible()}/${await sc.locator('.score-points li').count() > 0}`, 'true/true');
        check(`${label}｜没批出来：有"再让 AI 批一次"`, await shows(sc.locator('button', { hasText: '再让 AI 批一次' }), 3000), true);
        check(`${label}｜没批出来：没有显示 0 分或"答错了"`, await page.locator('text=答错了').count(), 0);
      }
    }

    // ── 段落填空、阅读理解：原文看得见，选对答案 ──
    for (const type of ['段落填空', '阅读理解', '选择填空']) {
      const card = await openPractice(type);
      if (!card) continue;
      if (type !== '选择填空') {
        const passage = page.locator('.exam-passage').first();
        check(`${label}｜${type}：原文那一块看得见`, await shows(passage), true);
        // P1-X1：这类题离开原文做不了，手机、平板上也默认展开——不点任何按钮就看得见正文
        check(`${label}｜${type}：不点"展开"原文正文就看得见`, await shows(passage.locator('.passage-body'), 3000), true);
        if (type === '段落填空') {
          check(`${label}｜段落填空：原文里带着词库`, (await passage.innerText()).includes('词库'), true);
        }
      }
      const key = await keyOf(card);
      const letter = key ? KEYS[key].answer : null;
      const opts = card.locator('label.choice');
      check(`${label}｜${type}：选项看得见（${await opts.count()} 个），认出了题`, `${await shows(opts.first())}/${Boolean(letter)}`, 'true/true');
      if (type === '段落填空') {
        // P1-X2：15 个短选项排成网格，每一个都点得到（中心点没被底部按钮栏盖住）
        check(`${label}｜段落填空：选项排成网格`, await card.locator('.choice-grid').count(), 1);
        const n = await opts.count();
        let reachable = 0;
        for (let k = 0; k < n; k++) {
          const o = opts.nth(k);
          await o.scrollIntoViewIfNeeded();
          if (await o.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return Boolean(hit && el.contains(hit));
          })) reachable++;
        }
        check(`${label}｜段落填空：${n} 个选项都点得到`, reachable, n);
      }
      if (letter) {
        await card.locator('label.choice', { has: page.locator('.key', { hasText: `${letter}.` }) }).click();
        await page.click('button:has-text("提交答案")');
        check(`${label}｜${type}：选对了反馈"答对了"`, await shows(page.locator('.badge.ok', { hasText: '答对了' })), true);
        check(`${label}｜${type}：没有过时的"下一阶段"字样`, (await page.locator('body').innerText()).includes('下一阶段'), false);
      }
      if (width === 390) check(`手机｜${type}练习页没有横向滚动`, await noOverflow(page), true);
      await shot(page, width, `3-${type}`);
    }

    // ── 模考作答：逐部分看控件，把留空的几道填上，交卷 ──
    await page.goto(`${BASE}/app/pubeng/exam/${EXAMS[i]}/take`, { waitUntil: 'networkidle' });
    const took = await shows(page.locator('.q-card').first(), 15000);
    check(`${label}｜模考作答页打得开`, took, true);
    if (took) {
      const secs = page.locator('.sec-nav button');
      const nSec = await secs.count();
      let spellInputs = 0, longBoxes = 0, filled = 0;
      for (let s = 0; s < nSec; s++) {
        await secs.nth(s).click();
        await page.waitForTimeout(150);
        const cards = page.locator('.q-card');
        for (let k = 0; k < await cards.count(); k++) {
          const card = cards.nth(k);
          if (!(await card.isVisible())) continue;
          const key = await keyOf(card);
          const qt = key ? KEYS[key].qt : null;
          if (qt === 'spell_word') {
            const box = card.locator('input.input').first();
            if (await box.isVisible()) {
              spellInputs++;
              if (!(await box.inputValue())) { await box.fill(KEYS[key].answer); filled++; }
            }
          } else if (qt && qt.endsWith('_translate')) {
            const box = card.locator('textarea, input.input').first();
            if (await box.isVisible()) {
              longBoxes++;
              if (!(await box.inputValue())) { await box.fill('【全对】浏览器里写的答案'); filled++; }
            }
          }
        }
      }
      check(`${label}｜模考：拼写单词 ${N_SPELL} 道各一个看得见的输入框`, spellInputs, N_SPELL);
      // P1-G2：题库还不够的部分如实提示（段落填空、阅读理解现在各只有一份）
      let notes = 0;
      for (let s = 0; s < nSec; s++) {
        await secs.nth(s).click();
        if (await page.locator('.exam-bar .section-note').isVisible().catch(() => false)) notes++;
      }
      check(`${label}｜模考：有部分标着"可能与上次相同"`, notes > 0, true);
      check(`${label}｜模考：翻译题 ${N_LONG} 道各一个看得见的作答框`, longBoxes, N_LONG);
      check(`${label}｜模考：浏览器补填了留空的 4 道（拼写、词组、句子、段落各一道）`, filled, 4);
      if (width === 390) check('手机｜模考作答页没有横向滚动', await noOverflow(page), true);
      await shot(page, width, '4-exam-take');
      await page.waitForTimeout(800);   // 输入框停 600ms 才保存；交卷时会补发，这里多等一下更稳
      await page.click('text=交卷');
      await page.waitForURL(/\/report/, { timeout: 20000 }).catch(() => {});
    }

    // ── 成绩报告：翻译题按采分点 AI 批完，总分满分 ──
    await page.goto(`${BASE}/app/pubeng/exam/${EXAMS[i]}/report`, { waitUntil: 'networkidle' });
    const runBtn = page.locator('button', { hasText: 'AI 批改主观题并生成错题解析' });
    if (await shows(runBtn)) {
      await runBtn.click();
      check(`${label}｜报告：点了批改之后有结果提示`,
        await shows(page.locator('.alert, [role="alert"]', { hasText: '主观题批改了' }).first(), 30000), true);
      const tot = page.locator('[data-testid="total-score"]');
      check(`${label}｜报告：客观题全对、翻译全答到，总分 ${TOTAL} / ${TOTAL}`,
        await shows(tot) ? (await tot.innerText()).replace(/\s+/g, ' ').trim() : '（没出现）', `${TOTAL} / ${TOTAL}`);
      check(`${label}｜报告：批完了没有"待批改"`, await page.locator('.q-card .badge', { hasText: '待批改' }).count(), 0);
    } else {
      check(`${label}｜报告：看得见"AI 批改主观题"的按钮`, false, true);
    }
    check(`${label}｜公共英语的报告里没有"作文"两个字`, (await page.locator('body').innerText()).includes('作文'), false);
    // P1-X5：两篇阅读用模板的名字分开
    const rep = await page.locator('body').innerText();
    check(`${label}｜报告：两篇阅读分别叫"阅读理解（一）""阅读理解（二）"`, rep.includes('阅读理解（一）') && rep.includes('阅读理解（二）'), true);
    if (width === 390) check('手机｜报告页没有横向滚动', await noOverflow(page), true);
    await shot(page, width, '5-report');

    check(`${label}｜整个过程没有页面报错`, errors.join(' | ') || '无', '无');
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
