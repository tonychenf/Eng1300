// 生化学员端的浏览器检查（2026-10-04），由 ui-bio-exam.sh 准备好数据后调用。
//
// 断"看得见、点得动"（CLAUDE.md 四之二）：以前的检查断"元素在页面代码里"，datalist 的备选
// 永远在代码里、又永远看不见。等不到的元素只让那几条红，不抛错——抛错会把后面的检查全吞掉。
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const USER = process.env.UI_USER;
const PASS = process.env.UI_PASS;
const EXAMS = JSON.parse(process.env.UI_EXAMS);
const TERMP = JSON.parse(process.env.UI_TERMP);
const FILLP = JSON.parse(process.env.UI_FILLP);
const FILL_ANS = JSON.parse(process.env.UI_FILL_ANS);
const FILLW = JSON.parse(process.env.UI_FILLW);
const POOL6 = JSON.parse(process.env.UI_POOL6);
const STEM6 = process.env.UI_STEM6;
const N_SUBJ = Number(process.env.UI_N_SUBJ);
const SUBJ_PTS = Number(process.env.UI_SUBJ_PTS);
const TOTAL = Number(process.env.UI_TOTAL);
const PARTS = Number(process.env.UI_PARTS);
const TERM_SEC = process.env.UI_TERM_SEC;
const TERM_N = Number(process.env.UI_TERM_N);
const FILL_SEC = process.env.UI_FILL_SEC;

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};
const shows = (loc, timeout = 10000) =>
  loc.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
// 设了 UI_SHOTS（一个目录）就在手机宽度的几个关键画面截图，给人看一眼版式；平时不截
const shot = async (page, width, name) => {
  if (process.env.UI_SHOTS && width === 390) await page.screenshot({ path: `${process.env.UI_SHOTS}/${name}.png`, fullPage: true });
};

const browser = await chromium.launch({ executablePath: CHROME });
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];

try {
  for (const [i, [width, height, label]] of WIDTHS.entries()) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    page.on('dialog', (d) => d.accept());
    // 前端拆包（CR L1，2026-10-07）：学员这一路（练习、模考、报告、错题本、历史）下载的脚本里，
    // 不该有 KaTeX（第 1 章一个公式都没有）和后台页面的代码。断脚本内容、不断文件名：
    // 以前是一个大包，文件名里看不出它把什么都装进去了
    const jsSeen = { katex: false, admin: false, bytes: 0 };
    page.on('response', async (r) => {
      if (!/\.js(\?|$)/.test(r.url())) return;
      try {
        const body = await r.text();
        jsSeen.bytes += body.length;
        if (body.includes('KaTeX parse error')) jsSeen.katex = true;
        if (body.includes('删除内容组')) jsSeen.admin = true;   // 后台校对页上的按钮
      } catch { /* 跳转时取不到的响应不算 */ }
    });

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/app\/biochem/, { timeout: 15000 });

    // ── 练习：名词解释（要 AI 判的题）──
    await page.goto(`${BASE}/app/biochem/practice/${TERMP[i]}/run`, { waitUntil: 'networkidle' });
    const termBox = page.locator('textarea.long-answer-input').first();
    const termShown = await shows(termBox);
    check(`${label}｜练习名词解释：有一个看得见的大文本框（以前当选择题渲染，整页白屏）`, termShown, true);
    if (termShown) {
      await termBox.fill('肽键是一个氨基酸的羧基和另一个氨基酸的氨基脱水缩合形成的酰胺键');
      await page.click('button:has-text("提交答案")');
      const sc = page.locator('.self-check');
      const scShown = await shows(sc);
      check(`${label}｜交上去：看得见"练习不判分"的说明`, scShown && await sc.locator('.badge', { hasText: '练习不判分' }).isVisible(), true);
      check(`${label}｜没有"答错了"（以前写得再对也是红叉）`, await page.locator('text=答错了').count(), 0);
      const pts = sc.locator('.score-points li');
      check(`${label}｜参考答案的采分点列出来了、看得见`, (await pts.count()) > 0 && await pts.first().isVisible(), true);
      await shot(page, width, '1-practice-term');
      check(`${label}｜题卡上标的是"练习不判分"，不是"待批改"`,
        `${await page.locator('.q-card .badge', { hasText: '练习不判分' }).count()}/${await page.locator('.q-card .badge', { hasText: '待批改' }).count()}`, '1/0');
    }
    if (width === 390) check('手机｜练习页没有横向滚动', await noOverflow(page), true);

    // ── 练习：多空填空（q06，答案已知）──
    await page.goto(`${BASE}/app/biochem/practice/${FILLP[i]}/run`, { waitUntil: 'networkidle' });
    const fillCard = page.locator('.q-card').first();
    if (await shows(fillCard)) {
      const stem = await fillCard.locator('.q-stem').innerText();
      check(`${label}｜生化填空的题干不带"给定词："（那是英语词形改写的）`, stem.startsWith('给定词'), false);
      const boxes = fillCard.locator('input.input');
      check(`${label}｜一空一个输入框`, await boxes.count(), FILL_ANS.length);
      for (let k = 0; k < FILL_ANS.length; k++) await boxes.nth(k).fill(FILL_ANS[k]);
      await page.click('button:has-text("提交答案")');
      const right = await shows(page.locator('.badge.ok', { hasText: '答对了' }));
      check(`${label}｜全答对：反馈是"答对了"`, right, true);
      // 以前逐空结果没并进题卡：整题"答对了"，每个空却都标"错"
      check(`${label}｜每个空都标"对"`, await fillCard.locator('.badge.ok', { hasText: /^对$/ }).count(), FILL_ANS.length);
      await shot(page, width, '2-practice-fill');
    } else {
      check(`${label}｜填空练习出题了`, false, true);
    }

    // ── 练习：q06 候选池的一空填错（2026-10-07）──
    // 以前候选池的空各空没有自己的答案，答错了题卡上什么都不给；错题本里「正确答案」是空的、
    // 「你的答案」是一串 {"1":…} 代码。
    await page.goto(`${BASE}/app/biochem/practice/${FILLW[i]}/run`, { waitUntil: 'networkidle' });
    const wCard = page.locator('.q-card').first();
    if (await shows(wCard)) {
      const wBoxes = wCard.locator('input.input');
      // 第 1 空填池子外的词（错），第 2 空填池子里的第二个（顺序不限，算对），第 3 空填标准答案
      await wBoxes.nth(0).fill('赖氨酸');
      await wBoxes.nth(1).fill(POOL6[1]);
      await wBoxes.nth(2).fill(FILL_ANS[2]);
      await page.click('button:has-text("提交答案")');
      const hint = wCard.locator('.pool-hint').first();
      check(`${label}｜候选池的空答错了：看得见可填哪几个（以前什么都不给）`,
        await shows(hint) ? (await hint.innerText()).trim() : '（没出现）', `第 1、2 空可填：${POOL6.join('、')}（顺序不限）`);
      await shot(page, width, '2b-practice-pool-wrong');
    } else {
      check(`${label}｜填错的那次练习出题了`, false, true);
    }

    // ── 错题本：q06 的「你的答案」「正确答案」都是人话 ──
    await page.goto(`${BASE}/app/biochem/wrongbook`, { waitUntil: 'networkidle' });
    const wb = page.locator('.card', { hasText: STEM6 }).first();
    if (await shows(wb)) {
      await wb.locator('button').first().click();
      await shows(wb.locator('text=你的答案'));
      // 断展开之后整块看得见的文字，不断某个元素在不在——以前那一块也在，只是写着 {"1":…}、正确答案空着
      const panel = (await wb.innerText()).replace(/[ \t]+/g, ' ');
      const lineOf = (head) => panel.split('\n').map((l) => l.trim()).find((l) => l.startsWith(head)) || '（没有这一行）';
      check(`${label}｜错题本：你的答案逐空写、标出错的那一空（以前是 {"1":…} 代码）`,
        lineOf('你的答案：'), `你的答案：第 1 空：赖氨酸（错）；第 2 空：${POOL6[1]}（对）；第 3 空：${FILL_ANS[2]}（对）`);
      check(`${label}｜错题本：展开之后看不到 {" 这种代码`, panel.includes('{"'), false);
      check(`${label}｜错题本：正确答案不是空的，候选池的几个和第 3 空的答案都在`,
        [...POOL6, FILL_ANS[2]].every((w) => lineOf('正确答案：').includes(w)), true);
      await shot(page, width, '2c-wrongbook');
    } else {
      check(`${label}｜错题本里有 q06`, false, true);
    }

    // ── 模考作答 ──
    await page.goto(`${BASE}/app/biochem/exam/${EXAMS[i]}/take`, { waitUntil: 'networkidle' });
    const took = await shows(page.locator('.q-card').first(), 15000);
    check(`${label}｜作答页打得开`, took, true);
    if (took) {
      check(`${label}｜四个部分`, await page.locator('.sec-nav button').count(), PARTS);
      await page.click(`.sec-nav button:text-is("${TERM_SEC}")`);
      const areas = page.locator('textarea.long-answer-input');
      await shows(areas.first());
      let visible = 0;
      for (let k = 0; k < await areas.count(); k++) if (await areas.nth(k).isVisible()) visible++;
      check(`${label}｜名词解释那部分：${TERM_N} 道各一个看得见的大文本框`, visible, TERM_N);
      if (visible > 0) {
        // 第一道名词解释是留给浏览器写的（ui-bio-exam.sh 没替它填）
        check(`${label}｜第一道还空着`, await areas.first().inputValue(), '');
        await areas.first().fill('【全对】浏览器里写的答案');
        await shot(page, width, '3-exam-take');
      }
      // 页面白屏之后这些都等不到：只让对应的检查红，不去点（等不到就抛错会把后面的检查全吞掉）
      const fillBtn = page.locator(`.sec-nav button:text-is("${FILL_SEC}")`);
      if (await shows(fillBtn, 3000)) {
        await fillBtn.click();
        const firstFill = page.locator('.q-card').first();
        await shows(firstFill);
        check(`${label}｜作答页的填空题干也不带"给定词："`, (await firstFill.locator('.q-stem').innerText()).startsWith('给定词'), false);
        if (width === 390) check('手机｜作答页没有横向滚动', await noOverflow(page), true);
        await page.waitForTimeout(300);   // 不等防抖：交卷时要把还欠着的那条补发出去
        await page.click('text=交卷');
        await page.waitForURL(/\/report/, { timeout: 20000 }).catch(() => {});
      } else {
        check(`${label}｜点到名词解释那部分之后作答页还在（没有白屏）`, false, true);
      }
    }

    // ── 成绩报告 ──
    await page.goto(`${BASE}/app/biochem/exam/${EXAMS[i]}/report`, { waitUntil: 'networkidle' });
    const badge = page.locator('[data-testid="pending-badge"]');
    check(`${label}｜待批改按卷面现算：主观题 ${N_SUBJ} 道（${SUBJ_PTS} 分）（以前写死"作文 30 分"）`,
      await shows(badge) ? await badge.innerText() : '（没出现）', `主观题 ${N_SUBJ} 道（${SUBJ_PTS} 分）待 AI 批改`);
    const runBtn = page.locator('button', { hasText: 'AI 批改主观题并生成错题解析' });
    if (await shows(runBtn)) {
      await runBtn.click();
      const msg = page.locator('.alert, [role="alert"]', { hasText: '主观题批改了' }).first();
      check(`${label}｜点了之后说批改了几道、得几分`, await shows(msg, 30000), true);
      const tot = page.locator('[data-testid="total-score"]');
      check(`${label}｜都批完了显示总分 ${TOTAL} / ${TOTAL}`,
        await shows(tot) ? (await tot.innerText()).replace(/\s+/g, ' ').trim() : '（没出现）', `${TOTAL} / ${TOTAL}`);
      const secBtn = page.locator(`button:has-text("第 ${TERM_SEC} 部分")`).last();
      if (await shows(secBtn, 3000)) await secBtn.click();
      const reason = page.locator('.point-reason').first();
      check(`${label}｜展开名词解释：逐点判定带着 AI 的理由、看得见`,
        await shows(reason) ? (await reason.innerText()).includes('替身') : false, true);
      await shot(page, width, '4-report-graded');
      check(`${label}｜批完了，这一部分没有"待批改"`, await page.locator('.q-card .badge', { hasText: '待批改' }).count(), 0);
    } else {
      check(`${label}｜看得见"AI 批改主观题"的按钮`, false, true);
    }
    check(`${label}｜生化的报告里没有"作文"两个字`, (await page.locator('body').innerText()).includes('作文'), false);
    if (width === 390) check('手机｜报告页没有横向滚动', await noOverflow(page), true);

    // ── 历史记录：只列本学科的模考，分母是卷面满分 ──
    await page.goto(`${BASE}/app/biochem/history`, { waitUntil: 'networkidle' });
    const rows = page.locator('table tbody tr');
    await shows(rows.first());
    check(`${label}｜历史里是 ${EXAMS.length} 张卷，练习会话不在里面（以前练习也列着，"继续作答"点进去是模考页）`,
      await rows.count(), EXAMS.length);
    check(`${label}｜交过的卷显示 ${TOTAL} / ${TOTAL}（以前写死 / 70）`,
      await page.locator('td', { hasText: `${TOTAL} / ${TOTAL}` }).count(), i + 1);

    check(`${label}｜整个过程没有页面报错`, errors.join(' | ') || '无', '无');
    check(`${label}｜学员这一路没下载 KaTeX、也没下载后台页面的代码（以前登录页就得全下完）`,
      `${jsSeen.katex}/${jsSeen.admin}`, 'false/false');
    if (i === 0) console.log(`     （学员这一路下载的脚本共 ${Math.round(jsSeen.bytes / 1024)} KB）`);
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
