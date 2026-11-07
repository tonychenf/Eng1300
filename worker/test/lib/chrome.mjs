// 浏览器测试用哪个 Chromium。以前 8 个浏览器用例各写死一份 /opt/pw-browsers/chromium-1194/...，
// 开发容器换了 Playwright 自带浏览器的版本（2026-11-07 这台是 chromium-1243）之后，每一套都死在
// browserType.launch：报"executable doesn't exist"，一条断言都没跑到。
// 依次找：环境变量 UI_CHROME → 环境给的固定链接 /opt/pw-browsers/chromium（不随版本变）→
// 带版本号的目录里任何一个 chrome。都没有就抛错，说清在哪找过——不回落成"不传路径"：
// 那样 Playwright 去找它自己版本对应的目录，报的是另一个不存在的路径，看不出是这里没找到。
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function chromePath() {
  const tried = [];
  const ok = (p) => { tried.push(p); return p && existsSync(p); };
  if (process.env.UI_CHROME && ok(process.env.UI_CHROME)) return process.env.UI_CHROME;
  if (ok('/opt/pw-browsers/chromium')) return '/opt/pw-browsers/chromium';
  const root = '/opt/pw-browsers';
  if (existsSync(root)) {
    for (const d of readdirSync(root).filter((x) => /^chromium-\d+$/.test(x)).sort().reverse()) {
      for (const sub of ['chrome-linux64', 'chrome-linux']) {
        const p = join(root, d, sub, 'chrome');
        if (ok(p)) return p;
      }
    }
  }
  throw new Error(`找不到 Chromium（找过：${tried.join('、') || '（无）'}）。用 UI_CHROME 指定可执行文件的路径`);
}
