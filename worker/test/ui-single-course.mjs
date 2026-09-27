// 单课程下的界面检查（真浏览器）。
//
// 题库只有 13000 一门课。只有一个选项的下拉框是白让人点一下，所以模考设置页
// 和练习设置页在课程数为 1 时不该出现课程选择器，但仍要让人看得到自己在考哪门。
//
// 用真浏览器而不是断言 JSX：这些是"渲染出来之后长什么样"的判断，读源码断言不出来。
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:8788';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const USER = process.env.UI_USER;
const PASS = process.env.UI_PASS;

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};

const browser = await chromium.launch({ executablePath: CHROME });
// 三种宽度都看一遍：手机、平板、PC
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];

try {
  for (const [width, height, label] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();

    await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    // N1 之后 /app 是学科选择页；这个学员只开通了 english 一个学科，
    // 所以会自动进去（判断是"可访问学科数 > 1 才显示选择页"）。
    await page.waitForURL(/\/app\/english/, { timeout: 15000 });

    // 模考设置页
    await page.goto(`${BASE}/app/english/exam/new`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=难度倾向', { timeout: 15000 });
    check(`${label}｜模考页没有课程下拉框`, await page.locator('select#course').count(), 0);
    const examText = await page.locator('body').innerText();
    check(`${label}｜模考页仍标出课程名`, /英语/.test(examText), true);
    check(`${label}｜模考页标出可用题数`, /可用\s*\d+\s*题/.test(examText), true);

    // 练习设置页
    await page.goto(`${BASE}/app/english/practice/new`, { waitUntil: 'networkidle' });
    await page.waitForSelector('text=题型范围', { timeout: 15000 });
    check(`${label}｜练习页没有课程下拉框`, await page.locator('select#course').count(), 0);
    // 去掉下拉后取题范围仍要能算出来，否则等于把功能连着控件一起删了
    await page.waitForSelector('text=可用题目', { timeout: 15000 });
    check(`${label}｜练习页仍能算出取题范围`,
      /可用题目\s*\d+/.test(await page.locator('body').innerText()), true);

    // 首页文案不该再说"选择课程"
    await page.goto(`${BASE}/app/english`, { waitUntil: 'networkidle' });
    // 锚在课程卡片自己的字上。"模拟考试"在导航栏里也有，手机上导航是收起来的，
    // 等它可见会一直等不到——那测的是导航不是首页。
    await page.waitForSelector('text=可用真题', { timeout: 15000 });
    check(`${label}｜首页不再写"选择课程"`,
      /选择课程/.test(await page.locator('body').innerText()), false);

    // 窄屏不允许横向滚动
    if (width === 390) {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 1);
      check('手机｜页面没有横向滚动', overflow, false);
    }

    // 改完密码本人不能被踢出去（CR-M2）。改密码会让这个账号所有旧令牌作废，包括页面手里
    // 这一个；服务端换发了新令牌，页面要存下它，否则下一个请求 401、被踢回登录页。
    // 放在最后一轮：改完密码之后的几轮就登不进去了。
    if (width === 1280) {
      await page.goto(`${BASE}/app/password`, { waitUntil: 'networkidle' });
      await page.fill('#cur', PASS);
      await page.fill('#new', 'changed12345');
      await page.fill('#confirm', 'changed12345');
      await page.click('button[type="submit"]');
      await page.waitForSelector('text=密码已修改', { timeout: 15000 });
      check('PC｜改密码成功', true, true);
      // 换个页面，逼页面用手里的令牌再发请求
      await page.goto(`${BASE}/app/english/exam/new`, { waitUntil: 'networkidle' });
      // 两种结局都要等得到：页面正常出来，或者被踢回登录页
      await Promise.race([
        page.waitForSelector('text=难度倾向', { timeout: 15000 }),
        page.waitForURL(/\/login/, { timeout: 15000 }),
      ]).catch(() => {});
      check('PC｜改完密码仍在登录状态（没被踢回登录页）',
        new URL(page.url()).pathname, '/app/english/exam/new');
      // 题数是接口给的：拿得到说明页面手里的令牌是新的那个
      check('PC｜改完密码后接口照常可用（页面拿到了题数）',
        /可用\s*\d+\s*题/.test(await page.locator('body').innerText()), true);
    }

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
