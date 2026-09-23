// N1 学科骨架的界面检查（真浏览器）。
//
// 后端断言证明不了这些：选择页渲染成什么样、切换器在不在、导航链接带没带学科码。
// 这些都是"渲染出来之后"的性质，读 JSX 断言不出来。
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE || 'http://127.0.0.1:8797';
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const USER = process.env.UI_USER;
const PASS = process.env.UI_PASS;

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};

const browser = await chromium.launch({ executablePath: CHROME });

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('input[name="username"], input#username, input[type="text"]', USER);
  await page.fill('input[type="password"]', PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.endsWith('/login'), { timeout: 15000 });
}

try {
  // ---- PC 宽度：主流程 ----
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await ctx.newPage();
    await login(page);

    // 两个学科，所以应该停在选择页而不是被自动带进某个学科
    await page.waitForSelector('.grid-cards', { timeout: 15000 });
    check('登录后停在学科选择页', new URL(page.url()).pathname, '/app');
    const cards = await page.locator('.grid-cards .card').count();
    check('选择页列出两个学科', cards, 2);

    const text = await page.locator('.grid-cards').innerText();
    check('英语学科可见', text.includes('英语'), 'true');
    check('生化学科可见', text.includes('生物化学'), 'true');
    check('没题的学科标成「尚未开放」', text.includes('尚未开放'), 'true');

    // 没题的学科不给进：按钮是禁用的
    const disabled = await page.locator('.grid-cards .card', { hasText: '生物化学' })
      .locator('button:disabled').count();
    check('没题的学科进不去（按钮禁用）', disabled, 1);

    // 进英语
    await page.locator('.grid-cards .card', { hasText: '英语' }).locator('a:has-text("进入")').click();
    await page.waitForURL(/\/app\/english/, { timeout: 15000 });
    check('进入学科后 URL 带学科码', new URL(page.url()).pathname, '/app/english');

    // 导航链接必须都带学科码，否则点一下就被弹回选择页
    await page.waitForSelector('.sidebar .nav-item', { timeout: 15000 });
    const hrefs = await page.locator('.sidebar .nav-item').evaluateAll(
      (els) => els.map((e) => e.getAttribute('href')));
    const appLinks = hrefs.filter((h) => h && h.startsWith('/app/') && !h.startsWith('/app/password'));
    check('侧边栏有学科内导航', appLinks.length > 0, 'true');
    check('学科内导航全部带学科码', appLinks.every((h) => h.startsWith('/app/english')), 'true');
    console.log(`       导航：${hrefs.join(' ')}`);

    // 切换器：可访问学科 2 个 > 1，应该出现
    check('学科切换器可见', await page.locator('.subject-switch').count(), 1);
    const opts = await page.locator('.subject-switch option').evaluateAll(
      (els) => els.map((e) => e.value));
    check('切换器里有生化', opts.includes('biochem'), 'true');
    check('切换器里有回到全部学科的出口', opts.includes('__pick__'), 'true');

    // 切到生化：URL 要变，学科名要变
    await page.selectOption('.subject-switch', 'biochem');
    await page.waitForURL(/\/app\/biochem/, { timeout: 15000 });
    check('切换学科后 URL 跟着变', new URL(page.url()).pathname, '/app/biochem');
    await page.waitForSelector('.nav-brand', { timeout: 15000 });
    const brand = await page.locator('.nav-brand').innerText();
    check('切换后标题显示新学科', brand.includes('生物化学'), 'true');

    // 不存在的学科：要给一句人话，不是白屏
    await page.goto(`${BASE}/app/nosuchsubject`, { waitUntil: 'networkidle' });
    const body = await page.locator('body').innerText();
    check('不存在的学科给出提示而不是白屏', /没有学科|打不开/.test(body), 'true');

    await ctx.close();
  }

  // ---- 手机与平板：选择页要能用 ----
  for (const [w, h, label] of [[390, 844, '手机'], [768, 1024, '平板']]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h } });
    const page = await ctx.newPage();
    await login(page);
    await page.waitForSelector('.grid-cards', { timeout: 15000 });
    check(`${label} 宽度下选择页列出两个学科`,
      await page.locator('.grid-cards .card').count(), 2);
    // 横向滚动是三端适配最常见的破绽
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    check(`${label} 宽度下选择页不横向滚动`, overflow, 'false');
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
