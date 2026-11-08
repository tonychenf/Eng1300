// 改进阶段 2 第一期·后台开新课的浏览器检查，由 ui-ph2-admin.sh 准备好数据后调用。
// 等不到的元素只让那几条红，不抛错。
import fs from 'node:fs';
import { chromium } from 'playwright';
import { chromePath } from './lib/chrome.mjs';

const BASE = process.env.UI_BASE;
const TEST2 = fs.readFileSync(process.env.UI_TEST2);
const TPL = JSON.parse(fs.readFileSync(process.env.UI_TPL, 'utf8'));
const N_TEST2 = Number(process.env.UI_N_TEST2);

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};
const shows = (loc, timeout = 10000) => loc.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const shot = async (page, width, name) => {
  if (process.env.UI_SHOTS && width === 390) await page.screenshot({ path: `${process.env.UI_SHOTS}/${name}.png`, fullPage: true });
};

const browser = await chromium.launch({ executablePath: chromePath() });
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];
const tplItems = [...TPL.items].sort((a, b) => a.ord - b.ord);

try {
  for (const [i, [width, height, label]] of WIDTHS.entries()) {
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/admin/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', 'admin');
    await page.fill('#password', 'adminpass123');
    await page.click('button[type="submit"]');
    // 别等 /\/admin/：它也匹配 /admin/login 本身，没登录完就往下走了
    await page.waitForURL((u) => u.pathname.startsWith('/admin') && !u.pathname.endsWith('/login'), { timeout: 15000 });

    // ── 开一门新课 ──
    await page.goto(`${BASE}/admin/subjects`, { waitUntil: 'networkidle' });
    const newBtn = page.locator('[data-testid="new-subject"]');
    const hasNew = await shows(newBtn);
    check(`${label}｜学科管理页有"开一门新课"`, hasNew, true);
    if (!hasNew) { await ctx.close(); continue; }
    await newBtn.click();
    check(`${label}｜建课表单看得见`, await shows(page.locator('[data-testid="subject-new-form"]')), true);
    const code = `uic${i}`;
    await page.fill('#sn-name', `浏览器课${i}`);
    await page.fill('#sn-code', code);
    await page.selectOption('#sn-copy', 'pubeng');
    if (width === 390) check('手机｜建课表单没有横向滚动', await noOverflow(page), true);
    await shot(page, width, '1-subject-new');
    await page.click('button:has-text("建课")');
    const ok = await page.waitForURL(/\/admin\/subjects\/\d+\/setup/, { timeout: 15000 }).then(() => true).catch(() => false);
    check(`${label}｜建完进了开新课引导`, ok, true);
    const sid = page.url().match(/subjects\/(\d+)\/setup/)?.[1];
    // 先等清单读回来（页面先显示"加载中"），再数步数
    check(`${label}｜引导页六步都看得见`, await shows(page.locator('.setup-step').first()) ? await page.locator('.setup-step').count() : 0, 6);
    check(`${label}｜提示复制来的提示词去看一眼`, await shows(page.locator('.alert', { hasText: '提示词' }).first(), 3000), true);
    check(`${label}｜状态是"还不能用"`, (await page.locator('[data-testid="setup-state"]').innerText()).trim(), '还不能用');
    if (width === 390) check('手机｜引导页没有横向滚动', await noOverflow(page), true);
    await shot(page, width, '2-setup');

    // ── 传题库文件 ──
    await page.locator('[data-testid="step-upload"] a', { hasText: '传题库文件' }).click();
    await page.waitForURL(/\/admin\/bank\/import/, { timeout: 10000 });
    await page.waitForSelector('#imp-file');
    check(`${label}｜从引导点过来，学科已经选好`, await page.locator('#imp-subject').inputValue(), code);
    check(`${label}｜文件框只收 .json`, await page.locator('#imp-file').getAttribute('accept'), '.json');
    await page.setInputFiles('#imp-file', { name: '样卷2.json', mimeType: 'application/json', buffer: TEST2 });
    check(`${label}｜文件真的进了 input`, await page.locator('#imp-file').evaluate((el) => el.files.length), 1);
    await page.click('button:has-text("试解析")');
    check(`${label}｜试解析出结果`, await shows(page.locator('text=试解析结果')), true);
    await page.click('button:has-text("确认入库")');
    const done = page.locator('.alert', { hasText: '已入库' });
    check(`${label}｜入库：${N_TEST2} 道题`, await shows(done) ? (await done.innerText()).includes(`${N_TEST2} 道题`) : '没出现', true);
    if (width === 390) check('手机｜上传页没有横向滚动', await noOverflow(page), true);

    // ── 组卷模板：按样卷生成草稿、填分值、保存 ──
    await page.goto(`${BASE}/admin/subjects/${sid}/template`, { waitUntil: 'networkidle' });
    check(`${label}｜模板页有"按一份样卷生成草稿"`, await shows(page.locator('[data-testid="draft-card"]')), true);
    const opt = await page.locator('[data-testid="draft-from"] option').nth(1).getAttribute('value');
    await page.selectOption('[data-testid="draft-from"]', opt);
    await page.click('[data-testid="draft-go"]');
    const rows = page.locator('[data-testid="template-row"]');
    check(`${label}｜草稿 ${tplItems.length} 个部分`, await shows(rows.first()) ? await rows.count() : 0, tplItems.length);
    check(`${label}｜分值没填时合计标红`, await page.locator('[data-testid="template-total"].bad').count(), 1);
    const scores = page.locator('[data-testid="score-input"]');
    for (let k = 0; k < tplItems.length; k++) await scores.nth(k).fill(String(tplItems[k].scorePerQuestion));
    check(`${label}｜填完合计 = 满分 ${TPL.totalScore}`, (await page.locator('[data-testid="template-total"]').innerText()).includes(`合计 ${TPL.totalScore} 分`), true);
    if (width === 390) check('手机｜模板页没有横向滚动', await noOverflow(page), true);
    await shot(page, width, '3-template');
    await page.click('[data-testid="template-save"]');
    check(`${label}｜保存成功`, await shows(page.locator('.alert', { hasText: '保存好了' })), true);
    check(`${label}｜保存后每行带着体检（可选几题 / 几篇）`, await page.locator('[data-testid="template-row"]', { hasText: '可选' }).count(), tplItems.length);

    // ── 一键发布、开通 ──
    await page.goto(`${BASE}/admin/subjects/${sid}/setup`, { waitUntil: 'networkidle' });
    await page.click('[data-testid="publish-all"]');
    check(`${label}｜一键发布有结果提示`, await shows(page.locator('.alert', { hasText: '发布了' }), 20000), true);
    check(`${label}｜发布之后不再是"还不能用"`, (await page.locator('[data-testid="setup-state"]').innerText()).trim() !== '还不能用', true);
    await page.click('[data-testid="open-grant"]');
    const dlg = page.locator('[data-testid="grant-dialog"]');
    check(`${label}｜开通对话框看得见`, await shows(dlg), true);
    await dlg.locator('label.choice', { hasText: 'UIA01' }).click();
    await dlg.locator('[data-testid="grant-go"]').click();
    check(`${label}｜开通之后第 ⑥ 步打钩`, await shows(page.locator('[data-testid="step-grant"].done'), 10000), true);
    if (width === 390) check('手机｜开通之后引导页没有横向滚动', await noOverflow(page), true);
    await shot(page, width, '4-setup-done');

    // ── 后台首页、AI 配置 ──
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    check(`${label}｜后台首页有本月 AI 花费`, await shows(page.locator('[data-testid="spend-line"]')), true);
    await page.goto(`${BASE}/admin/ai`, { waitUntil: 'networkidle' });
    const card = page.locator('[data-testid="spend-card"]');
    check(`${label}｜AI 配置页有本月花费卡`, await shows(card), true);
    await page.fill('#budget-yuan', '20');
    await page.click('[data-testid="budget-save"]');
    check(`${label}｜保存每月上限`, await shows(card.locator('text=/ 上限 20 元')), true);
    await page.fill('#budget-yuan', '');
    await page.click('[data-testid="budget-save"]');
    check(`${label}｜清空 = 不设上限`, await shows(card.locator('text=没设上限')), true);
    if (width === 390) check('手机｜AI 配置页没有横向滚动', await noOverflow(page), true);

    check(`${label}｜整个过程没有页面报错`, errors.join(' | ') || '无', '无');
    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
