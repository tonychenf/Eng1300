// 改进阶段 2 第三期·AI 拆题导入页的浏览器检查，由 ui-ph2-import.sh 准备好服务后调用。
// 替身看不懂图：测试照片是在浏览器里画出来的一页"书"（JPEG），末尾接一段标记（STUBPAGE:<转写稿页码>:…），
// JPEG 解码器不管文件尾巴，页面原样上传（已经是 JPEG、长边不超过 2400），替身按标记回那一页的转写稿。
import { chromium } from 'playwright';
import { chromePath } from './lib/chrome.mjs';
import { TRUTH_PAGES } from '../src/ocr-bench/truth-data.js';

const BASE = process.env.UI_BASE;
let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};
const shows = (loc, timeout = 10000) => loc.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
const decoded = (loc) => loc.evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
const N = TRUTH_PAGES.find((p) => p.page === 121).questions.length + TRUTH_PAGES.find((p) => p.page === 122).questions.length;

// 在浏览器里画一页"书"：白底黑字一行行，导出 JPEG，再接上标记
async function bookPage(page, tag, { w = 1200, h = 1600 } = {}) {
  const b64 = await page.evaluate(async ([w, h]) => {
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#f4f4f0'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1a1a1a'; ctx.font = `${Math.round(w / 40)}px serif`;
    for (let y = h * 0.08; y < h * 0.92; y += w / 26) ctx.fillText('The quick brown fox jumps over the lazy dog 1234', w * 0.08, y);
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
    const buf = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (const c of buf) s += String.fromCharCode(c);
    return btoa(s);
  }, [w, h]);
  return Buffer.concat([Buffer.from(b64, 'base64'), Buffer.from(tag)]);
}
const tick = (page) => page.evaluate((u) => fetch(`${u}/cdn-cgi/local/scheduled?cron=*+*+*+*+*`).then((r) => r.status), BASE);

const browser = await chromium.launch({ executablePath: chromePath() });
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];
try {
  for (const [width, height, label] of WIDTHS) {
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

    // 入口：试卷与校对 → 导入资料（拍照）
    await page.goto(`${BASE}/admin/bank`, { waitUntil: 'networkidle' });
    const entry = page.locator('[data-testid="bank-import-photos"]');
    check(`${label}｜「试卷与校对」有「导入资料（拍照）」`, await shows(entry), true);
    await entry.click();
    check(`${label}｜导入页打开了`, await shows(page.locator('[data-testid="import-setup"]')), true);
    await page.selectOption('#imp-subject', 'pubeng');

    // 选三张：第 121 页、第 122 页（第 2 行会出乱码）、一张太小的
    const items = page.locator('[data-testid="import-item"]');
    const files = [
      { name: 'p121.jpg', mimeType: 'image/jpeg', buffer: await bookPage(page, 'STUBPAGE:121:0') },
      { name: 'p122.jpg', mimeType: 'image/jpeg', buffer: await bookPage(page, 'STUBPAGE:122:0:garble') },
      { name: 'small.jpg', mimeType: 'image/jpeg', buffer: await bookPage(page, 'STUBPAGE:123:0', { w: 600, h: 800 }) },
    ];
    await page.setInputFiles('[data-testid="import-files"]', files);
    const qcDone = async () => { for (let t = 0; t < 100; t++) { if ((await page.locator('[data-testid="import-qc"]').count()) === 3) return true; await page.waitForTimeout(100); } return false; };
    check(`${label}｜三张都列出来、都检查完了`, `${await items.count()}/${await qcDone()}`, '3/true');
    const badges = await page.locator('[data-testid="import-qc"]').allInnerTexts();
    check(`${label}｜清楚的两张：清楚；太小的那张：要重拍`, badges.join(','), '清楚,清楚,要重拍');
    check(`${label}｜缩略图真的解出来了`, await decoded(items.first().locator('img')), true);
    check(`${label}｜有要重拍的：开始不了，说清楚`, `${await page.locator('[data-testid="import-start"]').isDisabled()}/${(await page.locator('[data-testid="import-problems"]').innerText()).includes('要重拍')}`, 'true/true');
    await items.nth(2).locator('button:has-text("去掉")').click();
    check(`${label}｜去掉那张之后可以开始`, await page.locator('[data-testid="import-start"]').isEnabled(), true);
    // 调顺序：把第 2 张挪上去再挪回来（顺序就是页序）
    await items.nth(1).locator('button[aria-label="上移"]').click();
    check(`${label}｜上移之后顺序变了`, (await items.first().innerText()).includes('p122.jpg'), true);
    await items.nth(1).locator('button[aria-label="上移"]').click();
    check(`${label}｜挪回来`, (await items.first().innerText()).includes('p121.jpg'), true);
    if (width === 390) check('手机｜导入页没有横向滚动', await noOverflow(page), true);

    await page.click('[data-testid="import-start"]');
    await page.waitForURL(/\/admin\/import\/imp-/, { timeout: 30000 });
    check(`${label}｜开始后到了任务页，在排队识别`, await shows(page.locator('[data-testid="import-progress"]')) && ['待识别', '识别中'].includes(await page.locator('[data-testid="import-status"]').innerText()), true);

    // 后台每分钟一次：测试替它触发；页面每 5 秒自己刷新进度
    await tick(page);
    const review = page.locator('[data-testid="import-review"]');
    check(`${label}｜识别、拆题完，页面自己变成逐页核对`, await shows(review, 20000), true);
    const head = page.locator('[data-testid="review-head"]');
    check(`${label}｜顶上写着第几张、还剩几处可疑（有）`, /第 1\/2 张 · 还剩 [1-9]\d* 处可疑/.test(await head.innerText()), true);
    check(`${label}｜还有可疑处：入库按钮按不了`, await page.locator('[data-testid="review-commit"]').isDisabled(), true);
    const qs1 = page.locator('[data-testid="review-question"]');
    check(`${label}｜第 1 张（第 121 页）的题都列出来了`, await qs1.count(), TRUTH_PAGES.find((p) => p.page === 121).questions.length);
    check(`${label}｜第 1 张没有可疑处`, await shows(page.locator('[data-testid="review-clean"]')), true);

    // 改一道题的题干
    await qs1.first().locator('[data-testid="review-stem"]').fill('改过的题干 ____ 。');
    await qs1.first().locator('[data-testid="review-save"]').click();
    const savedNote = page.locator('[data-testid="review-question"]').first().locator('text=改过：stem');
    check(`${label}｜改题干保存了，标出改过`, await shows(savedNote), true);
    check(`${label}｜改过的字还在`, await qs1.first().locator('[data-testid="review-stem"]').inputValue(), '改过的题干 ____ 。');

    // 只看有可疑处的页 → 第 2 张（乱码、两次识别不一致）
    await page.locator('[data-testid="review-only-issues"]').check();
    check(`${label}｜只看有可疑处的页：跳到第 2 张`, await shows(page.locator('[data-testid="review-head"]', { hasText: '第 2/2 张' })), true);
    check(`${label}｜可疑处标出来了（黄底、带原因）`, (await page.locator('[data-testid="review-issue"]').count()) > 0 && /乱码|不一致/.test(await page.locator('[data-testid="review-issue"]').first().innerText()), true);
    await page.locator('[data-testid="review-page-ok"]').click();
    check(`${label}｜这页没问题 → 可疑处清零、可以入库`,
      (await shows(page.locator('[data-testid="review-head"]', { hasText: '还剩 0 处可疑' }))) && await page.locator('[data-testid="review-commit"]').isEnabled(), true);
    if (width === 390) check('手机｜核对页没有横向滚动', await noOverflow(page), true);

    await page.click('[data-testid="review-commit"]');
    const done = page.locator('[data-testid="import-done"]');
    check(`${label}｜入库了，给出去校对页的链接`, await shows(done, 20000), true);
    check(`${label}｜入库 ${N} 道题、AI 接着出了答案`, await shows(page.locator(`text=/已入库 ${N} 道题；AI 生成了 ${N} \\/ ${N} 道/`), 20000), true);
    await done.locator('a').click();
    check(`${label}｜点过去是这一章的校对页`, await page.waitForURL(/\/admin\/bank\/pubeng-imp/, { timeout: 10000 }).then(() => true).catch(() => false), true);

    check(`${label}｜整个过程没有页面报错`, errors.join(' | ') || '无', '无');
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
