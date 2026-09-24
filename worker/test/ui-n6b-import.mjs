// 后台上传界面的浏览器实测（N6b-5）。
//
// 要看的是**整条流程在三种宽度下都走得通**，不是页面能不能打开：
// 选学科 → 填字段 → 选文件 → 试解析 → 看预览 → 确认入库 → AI 接着跑 → 出结果。
// 只断"页面渲染出来了"的话，按钮禁用逻辑写错、上传发出去是个空 body、
// AI 那步的结果没显示，全都测不到。
import { chromium } from 'playwright';

const BASE = process.env.UI_BASE;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const USER = process.env.UI_USER;
const PASS = process.env.UI_PASS;
const DOCX = process.env.UI_DOCX;

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
    const gid = `biochem-ui-${width}`;
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/admin/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', USER);
    await page.fill('#password', PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin') && !u.pathname.includes('login'),
      { timeout: 15000 });

    // 从试卷列表点进去——入口找不到的话这个功能等于不存在
    await page.goto(`${BASE}/admin/bank`, { waitUntil: 'networkidle' });
    await page.click('text=上传题库');
    await page.waitForSelector('#imp-subject', { timeout: 15000 });
    check(`${label}｜从试卷列表进得到上传页`, page.url().endsWith('/admin/bank/import'), true);

    // 什么都没填时，两个按钮都不能点，而且要说得出差什么
    const dryBtn = page.locator('button', { hasText: '试解析' });
    const commitBtn = page.locator('button', { hasText: '确认入库' });
    check(`${label}｜没填完时"试解析"点不了`, await dryBtn.isDisabled(), true);
    check(`${label}｜提示里说得出差哪些`,
      (await page.locator('body').innerText()).includes('还差：'), true);

    await page.selectOption('#imp-subject', 'biochem');
    await page.fill('#imp-gid', gid);
    await page.fill('#imp-label', `浏览器实测 ${label}`);
    await page.fill('#imp-order', String(width));
    await page.setInputFiles('#imp-file', DOCX);
    check(`${label}｜填完之后"试解析"能点了`, await dryBtn.isDisabled(), false);
    // 还没试解析，不许直接入库——解析结果没人看过就落库，正是这个页面要防的
    check(`${label}｜没试解析前"确认入库"点不了`, await commitBtn.isDisabled(), true);

    // ── 试解析 ──
    await dryBtn.click();
    await page.waitForSelector('text=试解析结果（还没入库）', { timeout: 60000 });
    const previewText = await page.locator('body').innerText();
    check(`${label}｜预览里报了 34 道题`, /题目\s*\n?\s*34/.test(previewText), true);
    check(`${label}｜预览里报了 50 个空`, /填空的空\s*\n?\s*50/.test(previewText), true);
    check(`${label}｜预览列出了四个题型分组`,
      await page.locator('table.table tbody tr').count() >= 4, true);
    check(`${label}｜预览里有「原题有误」`, previewText.includes('原题有误'), true);
    check(`${label}｜并且带订正前后`, previewText.includes('订正前：'), true);
    check(`${label}｜提醒了原件会被丢弃`, previewText.includes('解析完原件就丢弃'), true);
    check(`${label}｜试解析页不横向滚动`, await noHScroll(page), true);

    // ── 确认入库（会自动接着跑 AI）──
    await commitBtn.click();
    await page.waitForSelector('text=AI 候选答案', { timeout: 120000 });
    const doneText = await page.locator('body').innerText();
    check(`${label}｜入库成功`, doneText.includes('已入库 34 道题'), true);
    check(`${label}｜AI 生成了候选答案`, /生成 34 \/ 34 道/.test(doneText), true);
    check(`${label}｜说清楚落在待核`, doneText.includes('待核'), true);
    // 这一条是硬约束在界面上的落点：不能让人以为 AI 跑完就能发布了
    check(`${label}｜明确说要逐题人工确认才能发布`,
      doneText.includes('逐题人工确认之后才能发布'), true);
    check(`${label}｜给了去校对的入口`,
      await page.locator('button', { hasText: '去校对这一章' }).count(), 1);
    check(`${label}｜结果页不横向滚动`, await noHScroll(page), true);

    // 触控目标（CLAUDE.md：44px）
    const box = await page.locator('button', { hasText: '去校对这一章' }).boundingBox();
    check(`${label}｜按钮高度够点`, (box?.height ?? 0) >= 44, true);

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
