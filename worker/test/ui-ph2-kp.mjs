// 改进阶段 2 第三期 F·考点整理页的浏览器检查，由 ui-ph2-kp.sh 准备好服务后调用。
// 三种宽度各动公共英语里不同的几个考点（合并是删东西的，不能重复用）；期望的个数、题数从知识点文件和接口现算。
import fs from 'node:fs';
import { chromium } from 'playwright';
import { chromePath } from './lib/chrome.mjs';

const BASE = process.env.UI_BASE;
const SID = process.env.UI_SID;
const FILE_KPS = JSON.parse(fs.readFileSync(process.env.UI_KP_FILE, 'utf8')).points;
let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};
const shows = (loc, timeout = 10000) => loc.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
const gone = (loc, timeout = 10000) => loc.waitFor({ state: 'detached', timeout }).then(() => true).catch(() => false);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];
// 每种宽度：改名的、调上级的（挪到哪个一级下，null 是改成一级）、合并的 A → B
const PLAN = [
  { rename: 'pe-voc-05', to: '拼写（手机改）', move: 'pe-rd-02', under: 'pe-voc', from: 'pe-voc-04', into: 'pe-voc-02' },
  { rename: 'pe-tr-03', to: '段落翻译（平板改）', move: 'pe-rd-01', under: 'pe-gra', from: 'pe-txt-b1u10', into: 'pe-txt-b1u09' },
  { rename: 'pe-txt-b2u02', to: '杰斐逊一课（PC 改）', move: 'pe-tr-02', under: null, from: 'pe-txt-b2u01', into: 'pe-txt-b1u09' },
];

const browser = await chromium.launch({ executablePath: chromePath() });
try {
  for (const [i, [width, height, label]] of WIDTHS.entries()) {
    const plan = PLAN[i];
    const ctx = await browser.newContext({ viewport: { width, height } });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text())) errors.push(m.text().slice(0, 160)); });
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/admin/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', 'admin');
    await page.fill('#password', 'adminpass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin') && !u.pathname.endsWith('/login'), { timeout: 15000 });
    const api = (path) => page.evaluate(async ([b, p]) => {
      const r = await fetch(`${b}/api${p}`, { headers: { Authorization: `Bearer ${localStorage.getItem('eng1300_token') || ''}` } });
      return r.ok ? r.json() : null;
    }, [BASE, path]);

    // 学科管理 → 考点整理
    await page.goto(`${BASE}/admin/subjects`, { waitUntil: 'networkidle' });
    const link = page.locator(`a[href="/admin/subjects/${SID}/knowledge-points"]`);
    check(`${label}｜学科管理里看得见「考点整理」`, await shows(link), true);
    await link.click();
    const rows = page.locator('[data-testid="kp-row"]');
    check(`${label}｜进了考点整理页，列出考点`, await shows(rows.first()), true);
    const before = await page.evaluate(() => [...document.querySelectorAll('[data-testid="kp-row"]')].map((r) => r.dataset.tag));
    const total = Number((await page.locator('[data-testid="kp-total"]').innerText()).match(/共 (\d+) 个/)?.[1]);
    check(`${label}｜考点数和页面列出的一样多`, before.length, total);
    if (i === 0) check('手机｜考点数和知识点文件一致（还没动过）', total, FILE_KPS.length);
    if (width === 390) check('手机｜没有横向滚动', await noOverflow(page), true);
    const row = (tag) => page.locator(`[data-testid="kp-row"][data-tag="${tag}"]`).first();

    // 改名：先撞名（报错、名字不变），再改成新名字
    const r1 = row(plan.rename);
    await r1.locator('[data-testid="kp-rename"]').first().click();
    const nameInput = r1.locator('[data-testid="kp-name-input"]');
    check(`${label}｜点改名，出来输入框`, await shows(nameInput), true);
    await nameInput.fill('词形与派生');
    await r1.locator('[data-testid="kp-save"]').click();
    check(`${label}｜改成已有的名字 → 报错、提示用合并`, await shows(page.locator('text=/已经有了.*合并/')), true);
    await nameInput.fill(plan.to);
    await r1.locator('[data-testid="kp-save"]').click();
    check(`${label}｜改名成功，列表里显示新名字`, (await shows(page.locator(`text=改成了「${plan.to}」`))) && (await row(plan.rename).locator('[data-testid="kp-name"]').first().innerText()) === plan.to, true);

    // 调上级
    const r2 = row(plan.move);
    await r2.locator('[data-testid="kp-parent"]').first().click();
    await r2.locator('[data-testid="kp-parent-select"]').selectOption(plan.under || '');
    await r2.locator('[data-testid="kp-save"]').click();
    await gone(page.locator('[data-testid="kp-editor"]'));
    const list = await api(`/admin/subjects/${SID}/knowledge-points`);
    const moved = list?.knowledgePoints.find((k) => k.tagId === plan.move);
    check(`${label}｜调上级 → ${plan.under ? `挂到 ${plan.under} 下` : '改成一级'}`, moved?.parentTagId ?? null, plan.under);
    // 页面上：挂到哪个一级下，就出现在那一张卡片里（改成一级的是自己那张卡片的第一行）
    const cardOf = await page.locator(`[data-testid="kp-row"][data-tag="${plan.move}"]`).first().evaluate((el) => el.closest('.card').querySelector('[data-testid="kp-row"]').dataset.tag);
    check(`${label}｜页面上它出现在对的那一组里`, cardOf, plan.under || plan.move);

    // 合并 A → B：题数转过去、A 那一行没了
    const kpA = list.knowledgePoints.find((k) => k.tagId === plan.from);
    const kpB = list.knowledgePoints.find((k) => k.tagId === plan.into);
    const r3 = row(plan.from);
    await r3.locator('[data-testid="kp-merge"]').first().click();
    const go = r3.locator('[data-testid="kp-merge-go"]');
    check(`${label}｜没选合并到哪个：合并按钮按不了`, await go.isDisabled(), true);
    await r3.locator('[data-testid="kp-into-select"]').selectOption(plan.into);
    check(`${label}｜说清要转过去几道题、撤不回`, /撤不回/.test(await r3.locator('[data-testid="kp-editor"]').innerText()), true);
    await go.click();
    check(`${label}｜合并成功的提示`, await shows(page.locator(`text=/合并进了「${kpB.name}」/`)), true);
    check(`${label}｜A 那一行没了`, await gone(page.locator(`[data-testid="kp-row"][data-tag="${plan.from}"]`)), true);
    const after = await api(`/admin/subjects/${SID}/knowledge-points`);
    const b2 = after.knowledgePoints.find((k) => k.tagId === plan.into);
    check(`${label}｜B 的题数 ≥ 合并前两边里多的那个、≤ 两边相加`, b2.questions >= Math.max(kpA.questions, kpB.questions) && b2.questions <= kpA.questions + kpB.questions, true);
    check(`${label}｜B 那一行显示的题数跟着变了`, new RegExp(`^${b2.questions} 道题`).test(await row(plan.into).locator('[data-testid="kp-counts"]').first().innerText()), true);
    check(`${label}｜考点总数少了一个`, Number((await page.locator('[data-testid="kp-total"]').innerText()).match(/共 (\d+) 个/)?.[1]), total - 1);

    check(`${label}｜整个过程没有页面报错`, errors.join(' | ') || '无', '无');
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
