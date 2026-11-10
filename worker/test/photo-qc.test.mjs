// 拍照质检（改进阶段 2 第三期 P3-C1，web/src/lib/photo-qc.js）。纯 node：拿合成的"书页"算。
// 每条规则一个做坏的样本：清楚的页一条不报；糊了、太暗、反光、太小、拍歪、边上裁掉，各报各的。
import { assessPhoto, laplacianVariance, skewAngle, edgeText, QC } from '../../web/src/lib/photo-qc.js';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want) || JSON.stringify(got) === JSON.stringify(want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};

// 合成一页：白底，一行行"字"（短横的黑块），可以整体倾斜、可以把字排到边上
function page({ w = 750, h = 1000, angle = 0, bg = 235, ink = 30, margin = 60, toEdge = false } = {}) {
  const g = new Uint8ClampedArray(w * h).fill(bg);
  const t = Math.tan((angle * Math.PI) / 180);
  const x0 = toEdge ? 0 : margin;
  const x1 = toEdge ? w : w - margin;
  for (let line = margin; line < h - margin; line += 28) {
    for (let x = x0; x < x1; x++) {
      if ((x - x0) % 24 > 17) continue;            // 字与字之间的空
      for (let dy = 0; dy < 12; dy++) {
        if ((x + dy) % 3 === 0) continue;          // 字里的笔画
        const y = Math.round(line + dy + (x - w / 2) * t);
        if (y >= 0 && y < h) g[y * w + x] = ink;
      }
    }
  }
  return { g, w, h };
}
function blur({ g, w, h }, r = 4) {
  const out = new Uint8ClampedArray(g.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = y + dy, xx = x + dx;
      if (yy >= 0 && yy < h && xx >= 0 && xx < w) { s += g[yy * w + xx]; n++; }
    }
    out[y * w + x] = s / n;
  }
  return { g: out, w, h };
}
const rules = (r) => r.problems.map((p) => `${p.rule}/${p.level}`).sort();
const assess = (img, size = { width: 1500, height: 2000 }) => assessPhoto(size, img.g, img.w, img.h);

console.log('== 清楚的一页：一条都不报 ==');
const good = page();
const r0 = assess(good);
check('清楚的页 → ok', `${r0.level}/${rules(r0).join(',')}`, 'ok/');
check(`清楚的页拉普拉斯方差远大于 ${QC.minBlur}`, laplacianVariance(good.g, good.w, good.h) > QC.minBlur * 5, true);

console.log('== 每条规则一个坏样本 ==');
check('拍糊了 → 红', rules(assess(blur(good))), ['blur/red']);
check('太暗 → 红', rules(assess(page({ bg: 40, ink: 10 }))).includes('dark/red'), true);
// 反光：灰纸面上一块光斑（占两成）
const glare = page({ bg: 200 });
for (let y = 300; y < 650; y++) for (let x = 150; x < 600; x++) glare.g[y * glare.w + x] = 255;
check('反光（灰纸上一块发白）→ 红', rules(assess(glare)), ['glare/red']);
check('干净的扫描件（纸面纯白）不算反光', rules(assess(page({ bg: 255 }))).length, 0);
check('太小（短边 800）→ 红', rules(assess(good, { width: 800, height: 1100 })), ['small/red']);
const tilted = page({ angle: 8 });
check('拍歪 8° → 黄（算出来的角度在 7–9° 之间）', `${rules(assess(tilted)).join(',')}/${Math.abs(skewAngle(tilted.g, tilted.w, tilted.h)) >= 7 && Math.abs(skewAngle(tilted.g, tilted.w, tilted.h)) <= 9}`, 'skew/yellow/true');
check('歪 2° 不报', rules(assess(page({ angle: 2 }))).length, 0);
const cut = page({ toEdge: true });
check('字排到左右两边 → 黄（左、右）', `${rules(assess(cut)).join(',')}/${edgeText(cut.g, cut.w, cut.h).sort().join(',')}`, 'edge/yellow/left,right');
// 照片四周是一整片深色桌面：不算"字被裁掉"
const desk = page();
for (let y = 0; y < desk.h; y++) for (let x = 0; x < desk.w; x++) if (x < 25 || x >= desk.w - 25) desk.g[y * desk.w + x] = 20;
check('四周是深色桌面不算裁掉', edgeText(desk.g, desk.w, desk.h).length, 0);

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
