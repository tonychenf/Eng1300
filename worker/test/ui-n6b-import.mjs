// 后台上传界面的浏览器实测（N6b-5）。
//
// 要看的是**整条流程在三种宽度下都走得通**，不是页面能不能打开：
// 选学科 → 填字段 → 选文件 → 试解析 → 看预览 → 确认入库 → AI 接着跑 → 出结果。
// 只断"页面渲染出来了"的话，按钮禁用逻辑写错、上传发出去是个空 body、
// AI 那步的结果没显示，全都测不到。
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const BASE = process.env.UI_BASE;
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const USER = process.env.UI_USER;
const PASS = process.env.UI_PASS;
const DOCX = process.env.UI_DOCX;
// **不要把路径直接交给 setInputFiles。** Playwright 1.49 传非 ASCII 路径时
// 一个文件都不塞进去，而且不抛错（实测：同一份文件复制成 ASCII 名就正常）。
// 题库原件全是中文名，踩上去的表现是「选了文件但按钮还是点不了」——
// 看起来完全像页面的 bug，我照这个方向查了一个小时。
// 改用 buffer 形式：文件名仍是中文，走的还是页面真正会遇到的那条路。
const DOCX_BYTES = readFileSync(DOCX);
const DOCX_NAME = basename(DOCX);
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
    await page.setInputFiles('#imp-file',
      { name: DOCX_NAME, mimeType: DOCX_MIME, buffer: DOCX_BYTES });
    // 先断「文件真的进去了」再断按钮。少了这一条，测试助手静默失灵
    // 就会伪装成页面的 bug，而红的那条断言指的是完全无辜的地方。
    check(`${label}｜文件真的进了 input`, await page.evaluate(() => {
      const f = document.querySelector('#imp-file').files;
      return f.length === 1 ? f[0].name : `files=${f.length}`;
    }), DOCX_NAME);
    // 红的时候要说得出**是哪个字段还没满足**。页面自己把这句算好了（"还差：…"），
    // 直接把它带进断言，省得下一个人对着"期望 false 实际 true"去猜。
    const stillMissing = await page.locator('text=还差：').count()
      ? (await page.locator('text=还差：').first().innerText()) : '（页面说没缺）';
    check(`${label}｜填完之后"试解析"能点了｜${stillMissing}`, await dryBtn.isDisabled(), false);
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
    // 考点和答案同一次调用要（2026-10-03：考点由题库里的题产生），结果里要说出来。
    // 新起的名字只在第一轮断：这套没导任何考点，第一轮（手机）起的「替身新考点」后面几轮就是已有的了
    check(`${label}｜AI 结果里说了 34 道带上了考点、要校对时确认`,
      doneText.includes('34 道题带上了 AI 给的考点，校对时一并确认'), true);
    if (label === '手机') {
      check(`${label}｜  并列出新起的考点名`, /新起了 1 个考点：替身新考点/.test(doneText), true);
    }
    // 这一条是硬约束在界面上的落点：不能让人以为 AI 跑完就能发布了
    check(`${label}｜明确说要逐题人工确认才能发布`,
      doneText.includes('逐题人工确认之后才能发布'), true);
    check(`${label}｜给了去校对的入口`,
      await page.locator('button', { hasText: '去校对这一章' }).count(), 1);
    check(`${label}｜结果页不横向滚动`, await noHScroll(page), true);

    // 触控目标（CLAUDE.md：44px）
    const box = await page.locator('button', { hasText: '去校对这一章' }).boundingBox();
    check(`${label}｜按钮高度够点`, (box?.height ?? 0) >= 44, true);

    // ── 校对页的「删除内容组」（CR-M4）──
    // 上传撞 id 时的报错叫人去这里删；以前这个按钮不存在。
    await page.locator('button', { hasText: '去校对这一章' }).click();
    await page.waitForURL((u) => u.pathname === `/admin/bank/${gid}`, { timeout: 15000 });
    const delBtn = page.locator('button', { hasText: '删除内容组' });
    await delBtn.waitFor({ timeout: 15000 }).catch(() => {});
    // 按钮不在时后面的点击会等满 30 秒再抛错，整个脚本崩掉、连小结都不打。
    // 没有按钮就只让这几条红，不去点它
    const hasDel = (await delBtn.count()) === 1;
    check(`${label}｜校对页有「删除内容组」`, hasDel, true);
    const dbox = hasDel ? await delBtn.boundingBox() : null;
    check(`${label}｜删除按钮高度够点`, (dbox?.height ?? 0) >= 44, true);
    check(`${label}｜删除按钮整个在屏幕里`,
      Boolean(dbox) && dbox.x >= 0 && dbox.x + dbox.width <= width, true);
    check(`${label}｜校对页不横向滚动`, await noHScroll(page), true);

    if (label === '手机' && hasDel) {
      // 点了又取消：什么都不能发生。确认框是这个按钮唯一的保险
      let asked = '';
      page.once('dialog', async (d) => { asked = d.message(); await d.dismiss(); });
      await delBtn.click();
      await page.waitForTimeout(500);
      check(`${label}｜删除前先弹确认框，说清楚删了找不回来`, asked.includes('删了找不回来'), true);
      check(`${label}｜取消之后还留在校对页`, page.url().endsWith(`/admin/bank/${gid}`), true);
      check(`${label}｜取消之后这一章还在`,
        await page.locator('h1', { hasText: `浏览器实测 ${label}` }).count(), 1);
    }
    if (label === 'PC' && hasDel) {
      // 真删一次：回到列表、说出删了哪一章、列表里没有它了
      page.once('dialog', (d) => d.accept());
      await delBtn.click();
      await page.waitForURL((u) => u.pathname === '/admin/bank', { timeout: 15000 });
      await page.waitForSelector('text=已删除「浏览器实测 PC」', { timeout: 15000 }).catch(() => {});
      check(`${label}｜删完回到列表，并说出删了哪一章`,
        await page.locator('text=已删除「浏览器实测 PC」').count(), 1);
      await page.waitForSelector('table.table', { timeout: 15000 }).catch(() => {});
      check(`${label}｜列表里没有它了`,
        await page.locator('table.table td', { hasText: '浏览器实测 PC' }).count(), 0);
      check(`${label}｜另外两章还在列表里`,
        await page.locator('table.table td', { hasText: '浏览器实测' }).count(), 2);
    }

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
