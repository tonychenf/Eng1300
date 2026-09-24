// N6 后台界面的浏览器检查：内容组显示名、缺答案/待核的可见性、发布门在界面上的表现。
//
// 这几件事读源码断言不出来：
//   - "0 年 0 月" 是不是真的没出现在页面上（后端映射成 null 了，但界面上还有没有
//     别的地方在拼年月，只有渲染出来才知道）
//   - 答案没确认时"已发布"这个选项是不是真的点不了（disabled 属性在 DOM 里）
//   - 三种宽度下新加的那一列会不会把表格撑出横向滚动条
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const USER = process.env.UI_USER;
const PASS = process.env.UI_PASS;
const BIO_GROUP = process.env.UI_BIO_GROUP;
const BIO_LABEL = process.env.UI_BIO_LABEL;
const WANT_UNREVIEWED = process.env.UI_UNREVIEWED;

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};

const browser = await chromium.launch({ executablePath: CHROME });
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];
const noHScroll = (page) => page.evaluate(
  () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);

try {
  for (const [width, height, label] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/admin/, { timeout: 15000 });

    // ── 看板：缺答案与待核分开显示（§6.4.10） ──
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.grid-cards', { timeout: 15000 });
    const dash = await page.locator('.grid-cards').first().innerText();
    check(`${label}｜看板上有「待人工核对」`, dash.includes('待人工核对'), true);
    check(`${label}｜待核数字对得上`,
      /待人工核对\s*\n?\s*(\d+)/.exec(dash)?.[1], WANT_UNREVIEWED);
    check(`${label}｜看板不横向滚动`, await noHScroll(page), true);

    // ── 题库列表：内容组显示 label，不显示年月 ──
    await page.goto(`${BASE}/admin/bank`, { waitUntil: 'networkidle' });
    await page.waitForSelector('table.table', { timeout: 15000 });
    const listText = await page.locator('table.table').first().innerText();
    check(`${label}｜列表里有生化那一章的章节名`, listText.includes(BIO_LABEL), true);
    // 这一条是反面断言：后端把 0 映射成 null 了，但界面上任何一处拼年月都会在这里露出来
    check(`${label}｜列表里没有「0 年 0 月」`, /0\s*年\s*0\s*月/.test(listText), false);
    check(`${label}｜列表有「缺答案」这一列`, listText.includes('缺答案'), true);
    check(`${label}｜列表不横向滚动`, await noHScroll(page), true);

    // ── 校对页：待核徽标 + 发布门 ──
    await page.goto(`${BASE}/admin/bank/${BIO_GROUP}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('h1', { timeout: 15000 });
    check(`${label}｜校对页标题是章节名`, (await page.locator('h1').first().innerText()).trim(), BIO_LABEL);
    const badge = page.locator('.badge', { hasText: '待核' }).first();
    check(`${label}｜题卡上标出待核`, await badge.count() > 0, true);
    check(`${label}｜原题有误的记录带订正前后`,
      (await page.locator('body').innerText()).includes('订正前：'), true);

    // 点开第一道题，看答案状态那一组控件
    await page.locator('button.card-pad').first().click();
    await page.waitForSelector('#answerState', { timeout: 15000 });
    check(`${label}｜有答案状态下拉`, await page.locator('#answerState').inputValue(), '待核');
    const publishOpt = page.locator('#status option[value="已发布"]');
    check(`${label}｜待核时「已发布」点不了`, await publishOpt.isDisabled(), true);
    // 触控目标 44px（CLAUDE.md）：下拉是新加的，不能比别的控件矮
    const box = await page.locator('#answerState').boundingBox();
    check(`${label}｜下拉高度够点`, (box?.height ?? 0) >= 44, true);
    // 改成已确认之后同一个选项就能选了——这一对才说明禁用是跟着答案状态走的，
    // 而不是那个选项本来就一直是灰的
    await page.selectOption('#answerState', '已确认');
    check(`${label}｜确认之后「已发布」能选了`, await publishOpt.isDisabled(), false);
    check(`${label}｜校对页不横向滚动`, await noHScroll(page), true);

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
