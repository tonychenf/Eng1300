// 富媒体题干的浏览器检查（验收 G1、G4）。
//
// 要看的是"渲染出来之后长什么样"：图有没有真的加载出来、alt 有没有落到 <img alt>、
// 分式有没有被 KaTeX 排出来、三种宽度下会不会把页面撑出横向滚动条。
// 这几件事读源码断言不出来——尤其是"图加载出来了没有"，
// 静态资源配了 SPA 回落，路径错了会返回一张 HTML 页面而且也是 200。
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const USER = process.env.UI_USER;
const PASS = process.env.UI_PASS;
const ATTEMPT = process.env.UI_ATTEMPT;
const ORD = process.env.UI_ORD;
const ALT = process.env.UI_ALT;
const IMG_PATH = process.env.UI_IMG_PATH;

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};

const browser = await chromium.launch({ executablePath: CHROME });
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];

try {
  for (const [width, height, label] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/app\/english/, { timeout: 15000 });

    await page.goto(`${BASE}/app/english/exam/${ATTEMPT}/take`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.q-card', { timeout: 15000 });
    const card = page.locator('.q-card')
      .filter({ has: page.locator('.q-num', { hasText: new RegExp(`^${ORD}$`) }) }).first();
    await card.scrollIntoViewIfNeeded();

    // ── G1：图与 alt ──
    const img = card.locator('img').first();
    check(`${label}｜题干里渲染出一张图`, await card.locator('img').count(), 1);
    check(`${label}｜src 指向静态托管的路径`, await img.getAttribute('src'), `/bank/${IMG_PATH}`);
    check(`${label}｜alt 落到了 <img alt> 上`, await img.getAttribute('alt'), ALT);
    // 只看标签在不在是不够的：路径错了 SPA 回落会返回一张 HTML 页面，
    // <img> 照样在 DOM 里，只是渲染不出来。naturalWidth 才说明它真的是张图。
    check(`${label}｜图真的加载出来了`,
      await img.evaluate((el) => el.complete && el.naturalWidth > 0), true);
    check(`${label}｜图不超出题卡宽度`, await img.evaluate(
      (el) => el.getBoundingClientRect().width <= el.parentElement.getBoundingClientRect().width + 1), true);
    check(`${label}｜图注显示出来`, (await card.innerText()).includes('构造图'), true);

    // ── G4：KaTeX ──
    check(`${label}｜公式交给 KaTeX 排了`, await card.locator('.katex').count() > 0, true);
    // 分式排出来的标志是 .mfrac；只断 .katex 存在的话，
    // 一个没排出分式的 KaTeX（比如把 \frac 当普通文字）也会过
    check(`${label}｜排出来的是分式`, await card.locator('.katex .mfrac').count() > 0, true);
    check(`${label}｜公式里的分子分母都在`,
      /a/.test(await card.locator('.katex').first().innerText())
      && /b/.test(await card.locator('.katex').first().innerText()), true);
    // 题干里那段普通文字不能被公式或图吃掉
    check(`${label}｜题干正文还在`, (await card.innerText()).includes('下图'), true);

    if (width === 390) {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1);
      check('手机｜页面没有横向滚动', overflow, false);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
