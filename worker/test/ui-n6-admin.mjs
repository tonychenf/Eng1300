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
// 考点按学科（2026-10-03）：两个学科各自的考点名（从知识点文件现算）、学科名、一章英语
const EN_GROUP = process.env.UI_EN_GROUP;
const BIO_SUBJECT = process.env.UI_BIO_SUBJECT;
const EN_SUBJECT = process.env.UI_EN_SUBJECT;
const BIO_KPS = JSON.parse(process.env.UI_BIO_KPS);
const EN_KPS = JSON.parse(process.env.UI_EN_KPS);
const sorted = (xs) => JSON.stringify([...xs].sort());

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
    // 不能等 /\/admin/：当前就在 /admin/login 上，这个模式当场就匹配，
    // waitForURL 立刻返回，于是下一句 goto 跑在令牌落进 localStorage 之前，
    // Guard 把它弹回登录页——症状是"等不到 .grid-cards"，看着像页面坏了。
    await page.waitForURL((u) => u.pathname.startsWith('/admin') && !u.pathname.includes('login'),
      { timeout: 15000 });

    // ── 看板：缺答案与待核分开显示（§6.4.10） ──
    await page.goto(`${BASE}/admin`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.grid-cards', { timeout: 15000 });
    const dash = await page.locator('.grid-cards').first().innerText();
    check(`${label}｜看板上有「待人工核对」`, dash.includes('待人工核对'), true);
    check(`${label}｜待核数字对得上`,
      /待人工核对\s*\n?\s*(\d+)/.exec(dash)?.[1], WANT_UNREVIEWED);
    check(`${label}｜看板不横向滚动`, await noHScroll(page), true);

    // ── 看板的考点分布按学科分组（以前两科的标签混在一排）──
    for (const [code, name, kps] of [['biochem', BIO_SUBJECT, BIO_KPS], ['english', EN_SUBJECT, EN_KPS]]) {
      const group = page.locator(`[data-subject="${code}"]`);
      const found = await group.count();
      check(`${label}｜考点分布里有「${name}」一组`, found, 1);
      // 没有这一组时不去读它：innerText 会干等 30 秒再抛错，后面的检查一条都跑不到
      const names = found ? await group.locator('.tag').evaluateAll(
        (ts) => ts.map((t) => (t.firstChild?.textContent || '').trim())) : [];
      check(`${label}｜  这一组非空，而且都是${name}的考点`,
        names.length > 0 && names.every((n) => kps.includes(n)), true);
      check(`${label}｜  组标题写着学科和个数`,
        found ? (await group.locator('h3').innerText()).trim() : '（没有这一组）', `${name}（${names.length} 个）`);
    }

    // ── 题库列表：内容组显示 label，不显示年月 ──
    await page.goto(`${BASE}/admin/bank`, { waitUntil: 'networkidle' });
    await page.waitForSelector('table.table', { timeout: 15000 });
    const listText = await page.locator('table.table').first().innerText();
    check(`${label}｜列表里有生化那一章的章节名`, listText.includes(BIO_LABEL), true);
    // 这一条是反面断言：后端把 0 映射成 null 了，但界面上任何一处拼年月都会在这里露出来
    check(`${label}｜列表里没有「0 年 0 月」`, /0\s*年\s*0\s*月/.test(listText), false);
    // 不能断表格文本里有"缺答案"三个字：窄屏下 .table.responsive 把 thead 藏了，
    // 列名由 CSS 的 ::before 从 data-label 渲染出来，不进 innerText——
    // 于是这条在手机/平板上永远是 false，而列其实是在的。
    // 断单元格本身：每一行都要有这一列，比"页面上出现过这三个字"也更严。
    const rows = await page.locator('table.table tbody tr').count();
    check(`${label}｜每一行都有「缺答案」这一列`,
      await page.locator('table.table td[data-label="缺答案"]').count(), rows);
    check(`${label}｜列表确实有行（否则上一条是空断言）`, rows > 0, true);
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
    // 时间按北京时间显示（CR-M7）：ui-n6.sh 给这一章的题写了世界时 2026-01-01 16:30:00 的确认时间，
    // 北京时间是第二天 00:30。以前原样显示，日期都差一天。
    check(`${label}｜确认时间按北京时间显示（世界时 01-01 16:30 → 北京 01-02 00:30）`,
      (await page.locator('body').innerText()).includes('上次确认：admin · 2026-01-02 00:30'), true);
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

    // ── 考点按学科：候选只有这一章所属学科的（以前英语、生化的混在一个列表里）──
    const kpOptions = async () => {
      await page.waitForFunction(() => document.querySelectorAll('#kp-library option').length > 0,
        null, { timeout: 15000 });
      return sorted(await page.locator('#kp-library option').evaluateAll((os) => os.map((o) => o.value)));
    };
    const kpLabel = async () => (await page.locator('label', { hasText: '考点标签' }).innerText()).trim();
    check(`${label}｜生化题的考点标题带学科名`, await kpLabel(), `考点标签（${BIO_SUBJECT}）`);
    check(`${label}｜生化题的候选正好是生化知识点文件里的考点`, await kpOptions(), sorted(BIO_KPS));
    check(`${label}｜  说清了列表里没有的名字会成为${BIO_SUBJECT}的新考点`,
      (await page.locator('body').innerText()).includes(`保存后成为${BIO_SUBJECT}的新考点`), true);

    // ── 单题停用 / 恢复（CR-H4）──
    // 按钮要真的在、够点（44px）；点下去先要确认（题会从学员那边消失）；停用后列表上看得出来、
    // 「已发布」点不了（先恢复）；恢复回得去。三种宽度各走一遍，每一轮自己恢复干净。
    const retireBtn = page.locator('button', { hasText: '停用这道题' });
    check(`${label}｜有停用按钮`, await retireBtn.count(), 1);
    const rb = await retireBtn.boundingBox();
    check(`${label}｜停用按钮够点（44px）`, (rb?.height ?? 0) >= 44, true);
    let asked = '';
    page.once('dialog', (d) => { asked = d.message(); d.accept(); });
    await retireBtn.click();
    await page.waitForSelector('[data-retired="1"]', { timeout: 15000 });
    check(`${label}｜停用前先问了一句，并说清后果`, asked.includes('抽不到'), true);
    check(`${label}｜列表上标出已停用`,
      await page.locator('[data-retired="1"] .badge', { hasText: '已停用' }).count(), 1);
    check(`${label}｜页头写着已停用 1 题`,
      (await page.locator('.page-head').innerText()).includes('已停用 1 题'), true);
    await page.locator('[data-retired="1"]').click();
    await page.waitForSelector('#status', { timeout: 15000 });
    check(`${label}｜停用的题「已发布」点不了`,
      await page.locator('#status option[value="已发布"]').isDisabled(), true);
    // 停用时间是刚才写下的世界时，页面上要是北京时间：和这里另算的北京时间差不出两分钟
    const retiredShown = ((await page.locator('body').innerText()).match(/这道题 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) 由/) || [])[1];
    const bjNow = Date.now() + 8 * 3600e3;
    check(`${label}｜停用时间按北京时间显示（「${retiredShown}」）`,
      Boolean(retiredShown) && Math.abs(Date.parse(`${retiredShown.replace(' ', 'T')}:00Z`) - bjNow) < 2 * 60e3, true);
    const restoreBtn = page.locator('button', { hasText: '恢复这道题' });
    check(`${label}｜有恢复按钮`, await restoreBtn.count(), 1);
    await restoreBtn.click();
    await page.waitForFunction(() => !document.querySelector('[data-retired="1"]'), null, { timeout: 15000 });
    check(`${label}｜恢复后列表上没有停用的题了`, await page.locator('[data-retired="1"]').count(), 0);

    // ── 考点按学科：英语那一章的候选只有英语的 ──
    await page.goto(`${BASE}/admin/bank/${EN_GROUP}`, { waitUntil: 'networkidle' });
    await page.locator('button.card-pad').first().click();
    await page.waitForSelector('#kp-library', { state: 'attached', timeout: 15000 });
    check(`${label}｜英语题的考点标题带学科名`, await kpLabel(), `考点标签（${EN_SUBJECT}）`);
    check(`${label}｜英语题的候选正好是英语知识点文件里的考点`, await kpOptions(), sorted(EN_KPS));

    // ── 重置密码的一次性口令（N7a）──
    //
    // 这一段要证明的就一件事：**口令不可能被错过**。原先它是表格上方的一条横幅，
    // 而重置按钮在每一行，学员一多就渲染在滚动区外，管理员看到的是"点了没反应"，
    // 刷新之后口令永久丢失、那个账号登不进去。
    // 所以断的不是"页面上有这段文字"，而是"它挡在眼前、且是模态的"。
    await page.goto(`${BASE}/admin/users`, { waitUntil: 'networkidle' });
    const userRows = page.locator('table.table tbody tr');
    check(`${label}｜账号列表打得开`, await userRows.count() >= 8, true);
    // 故意挑**最后一行**：那正是原先会把口令顶出视口的位置。
    // 但绝不能挑到 admin 自己——重置它，下一个宽度就登不进来了（第一版就是这么挂的，
    // 而且挂在"下一轮登录超时"上，看起来和口令弹窗毫无关系）。所以先断一句。
    const lastRow = userRows.last();
    const lastName = (await lastRow.locator('td').first().innerText()).trim();
    check(`${label}｜最后一行是学员不是管理员（重置 admin 会让下一轮登录挂掉）`,
      lastName.startsWith('T'), true);
    await lastRow.scrollIntoViewIfNeeded();
    page.once('dialog', (d) => d.accept());          // confirm("确认重置…")
    await lastRow.locator('button', { hasText: '重置密码' }).click();

    const dlg = page.locator('dialog.pw-dialog');
    await dlg.waitFor({ state: 'visible', timeout: 10000 });
    check(`${label}｜口令弹窗自己弹出来了`, await dlg.isVisible(), true);
    // 模态才会拦住后续操作；非模态的 <dialog> 一样 visible，所以这条要单独断
    check(`${label}｜而且是模态的（挡住背后的页面）`,
      await page.evaluate(() => document.querySelector('dialog.pw-dialog')?.matches(':modal')), true);
    const shown = await dlg.locator('.pw-code code').innerText();
    check(`${label}｜口令是一串非空的字符`, shown.trim().length >= 8, true);
    check(`${label}｜明说了要转交给本人`,
      (await dlg.innerText()).includes('转交'), true);
    check(`${label}｜明说了只显示这一次`,
      (await dlg.innerText()).includes('只显示这一次'), true);
    check(`${label}｜有复制按钮`, await dlg.locator('button', { hasText: '复制' }).count(), 1);
    // 弹窗在视口内——这是整件事的要害，横幅版本恰恰就败在这里
    const dlgBox = await dlg.boundingBox();
    const vp = page.viewportSize();
    check(`${label}｜弹窗落在视口里（横幅版本就是败在这）`,
      Boolean(dlgBox) && dlgBox.y >= 0 && dlgBox.y < vp.height, true);
    await dlg.locator('button', { hasText: '我已记下并转交' }).click();
    await dlg.waitFor({ state: 'hidden', timeout: 5000 });
    check(`${label}｜点完就关`, await dlg.count() === 0 || !(await dlg.isVisible()), true);

    await ctx.close();
  }
} finally {
  await browser.close();
}

console.log(`== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
