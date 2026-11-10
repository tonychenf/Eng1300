// 改进阶段 2 第二期·识别实测页的浏览器检查，由 ui-ph2-ocr.sh 准备好服务后调用。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { chromePath } from './lib/chrome.mjs';
import { truthFor } from '../src/ocr-bench/evaluate.js';
import { normalizeText } from '../src/lib/ocr-metrics.js';

const BASE = process.env.UI_BASE;
let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};
const shows = (loc, timeout = 10000) => loc.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

// 一张能解码的小 PNG（40×60 灰色），当"照片"传；替身看不懂图，按模型名回第 121 页
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((w + 1) * h, 0x80); for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const IMG = png(40, 60);
const K = 6;   // 替身在第 121 页上故意改的字数
const N = normalizeText(truthFor(121).text).s.length;
const WANT_ACC = `${((1 - K / N) * 100).toFixed(2)}%`;

const browser = await chromium.launch({ executablePath: chromePath() });
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];
try {
  for (const [width, height, label] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e.message || e)));
    page.on('dialog', (d) => d.accept());

    await page.goto(`${BASE}/admin/login`, { waitUntil: 'networkidle' });
    await page.fill('#username', 'admin');
    await page.fill('#password', 'adminpass123');
    await page.click('button[type="submit"]');
    await page.waitForURL((u) => u.pathname.startsWith('/admin') && !u.pathname.endsWith('/login'), { timeout: 15000 });

    await page.goto(`${BASE}/admin/ai`, { waitUntil: 'networkidle' });
    const link = page.locator('[data-testid="ocr-bench-link"]');
    check(`${label}｜AI 配置页有"去做识别实测"`, await shows(link), true);
    await link.click();
    check(`${label}｜识别实测页打开了`, await shows(page.locator('[data-testid="bench-setup"]')), true);

    await page.setInputFiles('[data-testid="bench-files"]', { name: '第121页.png', mimeType: 'image/png', buffer: IMG });
    const item = page.locator('[data-testid="bench-item"]');
    check(`${label}｜选的照片列出来了（读出了尺寸）`, await shows(item.first()) && (await item.first().innerText()).includes('40×60'), true);
    check(`${label}｜没标页码时开始不了`, await page.locator('[data-testid="bench-start"]').isDisabled(), true);
    await item.first().locator('select').selectOption('121');

    // 现在用的模型默认已选；再加一个故意改 6 个字的
    check(`${label}｜现在用的模型默认选上了`, await page.locator('[data-testid="bench-model"]').count(), 1);
    await page.fill('[data-testid="bench-extra-model"]', `stub-ocr:121:${K}`);
    await page.click('button:has-text("添加")');
    check(`${label}｜加上了第二个模型`, await page.locator('[data-testid="bench-model"]').count(), 2);
    // 只留 1600 一种尺寸，次数好算
    await page.locator('label.choice', { hasText: '2400' }).click();
    const est = await page.locator('[data-testid="bench-estimate"]').innerText();
    check(`${label}｜预估：共 2 次识别；第二个模型没填单价，说清算不出`, est.includes('共 2 次识别') && est.includes('没填单价'), true);
    if (width === 390) check('手机｜实测设置页没有横向滚动', await noOverflow(page), true);

    await page.click('[data-testid="bench-start"]');
    const report = page.locator('[data-testid="bench-report"]');
    check(`${label}｜出报告了`, await shows(report, 30000), true);
    const rows = report.locator('[data-testid="bench-row"]');
    check(`${label}｜报告两行（两个模型）`, await rows.count(), 2);
    const accs = await report.locator('[data-testid="bench-acc"]').allInnerTexts();
    check(`${label}｜原样回转写稿的模型：准确率 100.00%`, accs.includes('100.00%'), true);
    check(`${label}｜改了 ${K} 个字的模型：准确率 = 1 − ${K}/${N} = ${WANT_ACC}`, accs.includes(WANT_ACC), true);
    check(`${label}｜100% 那一行达到门槛`, (await rows.first().innerText()).includes('达到门槛'), true);
    const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await page.click('[data-testid="bench-export"]');
    const file = await dl;
    const md = file ? fs.readFileSync(await file.path(), 'utf8') : '';
    check(`${label}｜导出的报告有表格、有两个模型`, md.includes('识别实测报告') && md.includes('stub-ocr:121:0') && md.includes(`stub-ocr:121:${K}`), true);
    if (width === 390) check('手机｜报告页没有横向滚动', await noOverflow(page), true);

    await page.reload({ waitUntil: 'networkidle' });
    const pastBtn = page.locator('button', { hasText: '1 页 × 2 个模型' }).first();
    check(`${label}｜以前的实测列出来了`, await shows(pastBtn), true);
    await pastBtn.click();
    check(`${label}｜打开以前的实测，报告还在（指标存过）`,
      (await shows(page.locator('[data-testid="bench-report"]'))) && (await page.locator('[data-testid="bench-acc"]').allInnerTexts()).includes(WANT_ACC), true);

    check(`${label}｜整个过程没有页面报错`, errors.join(' | ') || '无', '无');
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
