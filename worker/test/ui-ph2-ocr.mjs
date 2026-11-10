// 改进阶段 2 第二期·识别实测页的浏览器检查，由 ui-ph2-ocr.sh 准备好服务后调用。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { chromium } from 'playwright';
import { chromePath } from './lib/chrome.mjs';
import { truthFor } from '../src/ocr-bench/evaluate.js';
import { normalizeText } from '../src/lib/ocr-metrics.js';
import { FREE_PAGE } from './fixtures/ocr-free-page.mjs';

const BASE = process.env.UI_BASE;
let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};
const shows = (loc, timeout = 10000) => loc.waitFor({ state: 'visible', timeout }).then(() => true).catch(() => false);
// 图真的解出来了（裂图的 alt 文字也"看得见"，只断 visible 测不出来）
const decoded = (loc) => loc.evaluate((img) => img.complete && img.naturalWidth > 0).catch(() => false);
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
// 转写稿里没有的那一页：两个模型只差第 2 行开头 KF 个字，一致率 = 1 − KF / 字数（按 ocr-metrics 的说法：换掉的字正好盖不住）
const KF = 3;
const NF = normalizeText(FREE_PAGE.join('\n')).s.length;
const WANT_AGREE = `${((1 - KF / NF) * 100).toFixed(2)}%`;

const browser = await chromium.launch({ executablePath: chromePath() });
const WIDTHS = [[390, 844, '手机'], [768, 1024, '平板'], [1280, 900, 'PC']];
try {
  for (const [width, height, label] of WIDTHS) {
    const ctx = await browser.newContext({ viewport: { width, height }, acceptDownloads: true, deviceScaleFactor: process.env.UI_SHOTS ? 2 : 1 });
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

    await page.goto(`${BASE}/admin/ai`, { waitUntil: 'networkidle' });
    const link = page.locator('[data-testid="ocr-bench-link"]');
    check(`${label}｜AI 配置页有"去做识别实测"`, await shows(link), true);
    await link.click();
    check(`${label}｜识别实测页打开了`, await shows(page.locator('[data-testid="bench-setup"]')), true);

    // 〇、选照片：一次多选、分几次加、拖进来，都是往后加；超过 10 张、不是图片的说清楚
    const items = page.locator('[data-testid="bench-item"]');
    const count = () => page.locator('[data-testid="bench-count"]').innerText();
    // 照片是读完尺寸才列出来的（异步）：等到正好 n 张。不用 waitForFunction——页面的 CSP 不许 eval，它在这里不可靠
    const waitItems = async (n) => {
      for (let t = 0; t < 100; t++) { if ((await items.count()) === n) return true; await page.waitForTimeout(100); }
      return false;
    };
    const pngs = (n, tag) => Array.from({ length: n }, (_, i) => ({ name: `${tag}-${i + 1}.png`, mimeType: 'image/png', buffer: IMG }));
    check(`${label}｜选照片的按钮看得见，写着可以多选`, await shows(page.locator('[data-testid="bench-pick"]')) && (await page.locator('[data-testid="bench-pick"]').innerText()).includes('一次选多张'), true);
    await page.setInputFiles('[data-testid="bench-files"]', pngs(3, '一次三张'));
    check(`${label}｜一次选 3 张：3 张都进来了`, await waitItems(3), true);
    if (process.env.UI_SHOTS && width === 390) await page.locator('[data-testid="bench-drop"]').screenshot({ path: `${process.env.UI_SHOTS}/ocr-pick-手机.png` });
    check(`${label}｜按钮变成"继续添加照片"，写着已选 3 / 10`, (await page.locator('[data-testid="bench-pick"]').innerText()).includes('继续添加') && (await count()).includes('已选 3 / 10'), true);
    await page.setInputFiles('[data-testid="bench-files"]', pngs(1, '再加一张'));
    check(`${label}｜再选 1 张：接着往后加（4 张），不是替换`, await waitItems(4) && (await items.nth(3).innerText()).includes('再加一张-1.png') && (await items.nth(0).innerText()).includes('一次三张-1.png'), true);
    // 电脑上把照片拖进框里
    const dt = await page.evaluateHandle(async (b64) => {
      const d = new DataTransfer();
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      for (const n of ['拖进来-1.png', '拖进来-2.png']) d.items.add(new File([bytes], n, { type: 'image/png' }));
      return d;
    }, IMG.toString('base64'));
    await page.locator('[data-testid="bench-drop"]').dispatchEvent('drop', { dataTransfer: dt });
    check(`${label}｜拖进来 2 张：6 张`, await waitItems(6), true);
    // 超过 10 张：只加到 10，说清多出来几张；不是图片的不加、说清楚
    await page.setInputFiles('[data-testid="bench-files"]', [...pngs(6, '凑满'), { name: '说明.txt', mimeType: 'text/plain', buffer: Buffer.from('x') }]);
    check(`${label}｜再选 6 张 + 1 个文本：加到 10 张为止`, await waitItems(10), true);
    const alert = await page.locator('[data-testid="bench-setup"]').evaluate(() => document.body.innerText);
    check(`${label}｜说清多出来的 2 张没加、说明.txt 不是图片`, alert.includes('多出来的 2 张没加') && alert.includes('说明.txt」不是图片'), true);
    check(`${label}｜满 10 张：不能再选了`, await page.locator('[data-testid="bench-files"]').isDisabled(), true);
    // 全去掉，下面按一张一张的流程走
    while (await items.count()) await items.first().locator('button:has-text("去掉")').click();
    check(`${label}｜去掉后回到 0 张，又能选了`, (await count()).includes('已选 0 / 10') && await page.locator('[data-testid="bench-files"]').isEnabled(), true);

    // 一、公共英语的一页：不用标页码，识别出来的字自己对上第 121 页
    await page.setInputFiles('[data-testid="bench-files"]', { name: 'IMG_0001.png', mimeType: 'image/png', buffer: IMG });
    const item = items;
    await waitItems(1);
    check(`${label}｜选的照片列出来了（读出了尺寸、有缩略图）`, await shows(item.first()) && (await item.first().innerText()).includes('40×60') && await decoded(item.first().locator('img')), true);
    check(`${label}｜不用标页码：没有页码下拉框`, await page.locator('[data-testid="bench-setup"] select').count(), 0);
    check(`${label}｜选了照片就能开始`, await page.locator('[data-testid="bench-start"]').isEnabled(), true);

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
    check(`${label}｜自动对上了转写稿第 121 页`, (await report.locator('[data-testid="bench-match"]').first().innerText()).includes('第 121 页'), true);
    const accs = await report.locator('[data-testid="bench-acc"]').allInnerTexts();
    check(`${label}｜原样回转写稿的模型：准确率 100.00%`, accs.includes('100.00%'), true);
    check(`${label}｜改了 ${K} 个字的模型：准确率 = 1 − ${K}/${N} = ${WANT_ACC}`, accs.includes(WANT_ACC), true);
    check(`${label}｜100% 那一行达到门槛`, (await rows.first().innerText()).includes('达到门槛'), true);
    check(`${label}｜原图和识别结果并排摆着（原图看得见、真的解出来了）`, await shows(report.locator('[data-testid="bench-photo-img"]').first()) && await decoded(report.locator('[data-testid="bench-photo-img"]').first()), true);
    // 切到改了字的那个模型：错的那几行标红
    await report.locator('[data-testid="bench-tab"]', { hasText: `stub-ocr:121:${K}` }).click();
    check(`${label}｜切到改了字的模型：有标红的行`, await report.locator('[data-testid="bench-text"] [data-mark="err"]').count() > 0, true);
    const dl = page.waitForEvent('download', { timeout: 10000 }).catch(() => null);
    await page.click('[data-testid="bench-export"]');
    const file = await dl;
    const md = file ? fs.readFileSync(await file.path(), 'utf8') : '';
    check(`${label}｜导出的报告有表格、有两个模型、写了对上哪一页`, md.includes('识别实测报告') && md.includes('stub-ocr:121:0') && md.includes(`stub-ocr:121:${K}`) && md.includes('对上转写稿：第 121 页'), true);
    if (width === 390) check('手机｜报告页没有横向滚动', await noOverflow(page), true);

    // 二、别的学科的一页（转写稿里没有）：不给准确率，原图旁边两个模型说法不一样的行标黄
    await page.click('button:has-text("再测一次")');
    await shows(page.locator('[data-testid="bench-setup"]'));
    for (const id of ['stub-ocr:121:0', `stub-ocr:121:${K}`]) {
      await page.locator('[data-testid="bench-model"]', { hasText: id }).locator('button:has-text("去掉")').click();
    }
    check(`${label}｜模型能去掉（去掉后一个都不剩）`, await page.locator('[data-testid="bench-model"]').count(), 0);
    for (const id of ['stub-ocr-free:0', `stub-ocr-free:${KF}`]) {
      await page.fill('[data-testid="bench-extra-model"]', id);
      await page.click('button:has-text("添加")');
    }
    await page.setInputFiles('[data-testid="bench-files"]', { name: '生化第2章.png', mimeType: 'image/png', buffer: IMG });
    await shows(page.locator('[data-testid="bench-item"]').first());
    check(`${label}｜第二轮：一张照片、两个模型`, `${await page.locator('[data-testid="bench-item"]').count()}/${await page.locator('[data-testid="bench-model"]').count()}`, '1/2');
    await page.click('[data-testid="bench-start"]');
    check(`${label}｜第二轮出报告了`, await shows(report, 30000), true);
    check(`${label}｜转写稿里没有：说清要对着原图看`, (await report.locator('[data-testid="bench-match"]').first().innerText()).includes('对着原图看'), true);
    check(`${label}｜没有准确率（不拿一份对不上的标准答案硬算）`, (await report.locator('[data-testid="bench-acc"]').allInnerTexts()).join(','), '—,—');
    check(`${label}｜两个模型的一致率 = 1 − ${KF}/${NF} = ${WANT_AGREE}`, (await report.locator('[data-testid="bench-agree"]').allInnerTexts()).join(','), `${WANT_AGREE},${WANT_AGREE}`);
    check(`${label}｜原图看得见、真的解出来了`, await shows(report.locator('[data-testid="bench-photo-img"]').first()) && await decoded(report.locator('[data-testid="bench-photo-img"]').first()), true);
    const marks = await report.locator('[data-testid="bench-text"] .bench-line').evaluateAll((els) => els.map((e) => e.dataset.mark || '-').join(','));
    check(`${label}｜说法不一样的只有第 2 行，标黄`, marks, '-,dis,-,-,-');
    if (width === 390) check('手机｜第二轮报告页没有横向滚动', await noOverflow(page), true);
    // UI_SHOTS=目录：把第二轮的报告截下来给人看（手机、PC）
    if (process.env.UI_SHOTS && width !== 768) {
      await report.locator('[data-testid="bench-photo"]').first().screenshot({ path: `${process.env.UI_SHOTS}/ocr-bench-${label}.png` });
    }

    await page.reload({ waitUntil: 'networkidle' });
    const pastBtn = page.locator('button', { hasText: '1 张 × 2 个模型' });
    check(`${label}｜以前的实测列出来了`, await shows(pastBtn.first()), true);
    // 最新的在最上面：先打开第二轮（看一致率还在），再打开第一轮（看准确率还在）
    await pastBtn.first().click();
    check(`${label}｜打开第二轮：一致率还在，原图没保存说清了`,
      (await shows(page.locator('[data-testid="bench-report"]'))) && (await page.locator('[data-testid="bench-agree"]').allInnerTexts()).includes(WANT_AGREE)
        && (await page.locator('[data-testid="bench-photo"]').first().innerText()).includes('原图没保存'), true);
    await pastBtn.nth(1).click();
    // 报告区原地换内容，等它真换成第一轮（对上第 121 页）再断，别读到还没换下去的第二轮
    await shows(page.locator('[data-testid="bench-match"]', { hasText: '第 121 页' }));
    check(`${label}｜打开第一轮：准确率还在（指标存过）`, (await page.locator('[data-testid="bench-acc"]').allInnerTexts()).includes(WANT_ACC), true);

    check(`${label}｜整个过程没有页面报错`, errors.join(' | ') || '无', '无');
    await ctx.close();
  }
} finally {
  await browser.close();
}
console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
