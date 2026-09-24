// 多单元作答控件的浏览器检查（§6.4.5、N5-5）。
//
// 用真浏览器而不是断言 JSX：要看的是"一空一个框、答完能交、报告里逐空标红"
// 这一串渲染出来的结果，读源码断言不出来。
//
// 卷子与要看的那道题由外面的脚本准备好，通过环境变量传进来——浏览器里再去找
// "哪道题挂了空"是靠猜，猜错了这套用例会在一道普通填空题上全绿。
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const USER = process.env.UI_USER;
const PASS = process.env.UI_PASS;
const ATTEMPT = process.env.UI_ATTEMPT;
const ORD = process.env.UI_ORD;            // 那道多空题在本卷里的题号
const SECTION = process.env.UI_SECTION;    // 它在第几部分（报告页要先展开那一部分）
const ANS = JSON.parse(process.env.UI_ANSWERS); // ["空1答案","空2答案","空3答案"]

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};

const browser = await chromium.launch({ executablePath: CHROME });
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];

try {
  let submitted = false;
  for (const [width, height, label] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/app\/english/, { timeout: 15000 });

    if (!submitted) {
      // ── 作答页：一空一个输入框 ──
      await page.goto(`${BASE}/app/english/exam/${ATTEMPT}/take`, { waitUntil: 'networkidle' });
      await page.waitForSelector('.q-card', { timeout: 15000 });
      // 作答页一次只显示一个部分，先点到那道题所在的部分上
      await page.click(`.sec-nav button:text-is("${SECTION}")`);
      await page.waitForTimeout(200);
      const card = page.locator('.q-card').filter({ has: page.locator('.q-num', { hasText: new RegExp(`^${ORD}$`) }) }).first();
      await card.scrollIntoViewIfNeeded();
      check(`${label}｜三个空各有一个输入框`, await card.locator('input.input').count(), 3);
      check(`${label}｜每个空都标了是第几空`,
        /第 1 空[\s\S]*第 2 空[\s\S]*第 3 空/.test(await card.innerText()), true);

      // 答对前两空、第三空写错
      const boxes = card.locator('input.input');
      await boxes.nth(0).fill(ANS[0]);
      await boxes.nth(1).fill(ANS[1]);
      await boxes.nth(2).fill('写错了');
      // 这里**故意**只等 300 毫秒就往下走：输入框的保存有 600 毫秒防抖，
      // 交卷时必须把还欠着的那几条补发出去。不补的话最后填的那个空会丢，
      // 界面上它是填了的、服务端收到的是空，判分判错而没有任何地方报错。
      await page.waitForTimeout(300);
      check(`${label}｜答题卡把它算成已答`,
        /已答 [1-9]\d*\//.test(await page.locator('body').innerText()), true);

      if (width === 390) {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1);
        check('手机｜作答页没有横向滚动', overflow, false);
      }

      // 最后一个宽度才交卷，前面两个宽度只看渲染
      if (label === 'PC') {
        await page.click('text=交卷');
        await page.waitForURL(/\/report/, { timeout: 20000 });
        submitted = true;
      }
    }

    if (submitted) {
      // ── 报告页：逐空标出对错，错的那空给出正确答案 ──
      await page.goto(`${BASE}/app/english/exam/${ATTEMPT}/report`, { waitUntil: 'networkidle' });
      // 逐题解析默认是收起的，要先展开那道题所在的部分
      await page.waitForSelector('text=逐题解析', { timeout: 15000 });
      await page.click(`button:has-text("第 ${SECTION} 部分")`);
      await page.waitForSelector('.q-card', { timeout: 15000 });
      const rcard = page.locator('.q-card').filter({ has: page.locator('.q-num', { hasText: new RegExp(`^${ORD}$`) }) }).first();
      const text = await rcard.innerText();
      check(`${label}｜报告里逐空给出判定`, (text.match(/第 \d 空/g) || []).length, 3);
      check(`${label}｜答错的空给出正确答案`, text.includes(ANS[2]), true);
      // 数"错"字出现几次是靠不住的：整题判定是"答错"、学生填的也是"写错了"，
      // 都带这个字。按逐空的徽章数才说得清——两个空判对、一个空判错。
      check(`${label}｜两个空判对`, await rcard.locator('.badge.ok').count(), 2);
      // 一个是这道题的整题判定（英语不给部分分，三空对二仍是答错），一个是第 3 空
      check(`${label}｜整题判错 + 一个空判错`, await rcard.locator('.badge.danger').count(), 2);
      if (width === 390) {
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth > window.innerWidth + 1);
        check('手机｜报告页没有横向滚动', overflow, false);
      }
    }

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
