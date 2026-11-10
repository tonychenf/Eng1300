// 拍照质检（改进阶段 2 第三期，PRD P3-C1 第一道关）：拍坏的照片不让上传。在浏览器里当场算，不花钱、不上传。
// 纯计算，输入灰度数组，node 里也能测（test/photo-qc.test.mjs）。
//
//   分辨率  短边 < 1000 像素                      红：太小，靠近一点重拍
//   模糊    灰度拉普拉斯方差 < 100（长边缩到 1000 算） 红：拍糊了
//   亮度    平均灰度 < 60；纸面不是纯白、却有 > 5% 过曝像素  红：太暗 / 反光（纯白纸面的扫描件不算反光）
//   歪斜    文字行倾角 > 5°（水平投影法）              黄：看得清就能继续，看不清再重拍
//   没拍全  四边 3% 的条带里有文字                    黄：边上可能被裁掉了
// 阈值是起始值，实测后再调（PRD 写明了）。红的必须重拍或删掉才能开始识别；黄的提示后可以继续。

export const QC = {
  minShort: 1000,
  minBlur: 100,
  dark: 60,
  bright: 230,
  overexposed: 0.05,
  maxSkew: 5,
  edgeBand: 0.03,
  analyzeLong: 1000,
};

/** RGBA → 灰度（0–255）。 */
export function toGray(rgba, w, h) {
  const g = new Uint8ClampedArray(w * h);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (rgba[i] * 299 + rgba[i + 1] * 587 + rgba[i + 2] * 114) / 1000;
  return g;
}

/** 拉普拉斯算子响应的方差：越清楚越大，糊了就小。 */
export function laplacianVariance(g, w, h) {
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      sum += v; sum2 += v * v; n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

export function brightness(g) {
  let sum = 0, over = 0;
  const hist = new Uint32Array(256);
  for (let i = 0; i < g.length; i++) { sum += g[i]; hist[g[i]]++; if (g[i] >= 250) over++; }
  let acc = 0, median = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= g.length / 2) { median = v; break; } }
  return { mean: g.length ? sum / g.length : 0, overexposed: g.length ? over / g.length : 0, median };
}

const isInk = (v) => v < 110;

/** 文字行倾角（度）：把深色像素按各个角度投影到纵轴，投影最"尖"（方差最大）的那个角度就是文字行的方向。 */
export function skewAngle(g, w, h, { range = 10, step = 1 } = {}) {
  const pts = [];
  const stride = Math.max(1, Math.round(Math.max(w, h) / 400));
  for (let y = 0; y < h; y += stride) for (let x = 0; x < w; x += stride) if (isInk(g[y * w + x])) pts.push(x, y);
  if (pts.length < 200) return 0;
  let best = 0, bestVar = -1;
  for (let a = -range; a <= range; a += step) {
    const t = Math.tan((a * Math.PI) / 180);
    const bins = new Map();
    for (let k = 0; k < pts.length; k += 2) {
      const r = Math.round((pts[k + 1] - pts[k] * t) / stride);
      bins.set(r, (bins.get(r) || 0) + 1);
    }
    let s = 0, s2 = 0;
    for (const c of bins.values()) { s += c; s2 += c * c; }
    const v = s2 / bins.size - (s / bins.size) ** 2;
    if (v > bestVar) { bestVar = v; best = a; }
  }
  return best;
}

/** 四条边上的条带里有没有"文字"：深浅交替多（文字），而不是一整片深色（桌面、背景）。 */
export function edgeText(g, w, h, band = QC.edgeBand) {
  const bw = Math.max(2, Math.round(w * band));
  const bh = Math.max(2, Math.round(h * band));
  const density = (x0, y0, x1, y1, horizontal) => {
    let flips = 0, ink = 0, n = 0;
    if (horizontal) {
      for (let y = y0; y < y1; y++) for (let x = x0 + 1; x < x1; x++) { const a = isInk(g[y * w + x - 1]); const b = isInk(g[y * w + x]); if (a !== b) flips++; if (b) ink++; n++; }
    } else {
      for (let x = x0; x < x1; x++) for (let y = y0 + 1; y < y1; y++) { const a = isInk(g[(y - 1) * w + x]); const b = isInk(g[y * w + x]); if (a !== b) flips++; if (b) ink++; n++; }
    }
    // 文字：深色占一部分、深浅来回跳；整片深色背景：深色多、几乎不跳
    return n ? { flips: flips / n, ink: ink / n } : { flips: 0, ink: 0 };
  };
  const sides = {
    top: density(0, 0, w, bh, true),
    bottom: density(0, h - bh, w, h, true),
    left: density(0, 0, bw, h, false),
    right: density(w - bw, 0, w, h, false),
  };
  return Object.entries(sides).filter(([, d]) => d.flips > 0.02 && d.ink > 0.02 && d.ink < 0.6).map(([k]) => k);
}

const SIDE = { top: '上', bottom: '下', left: '左', right: '右' };

/**
 * 一张照片的质检结论。
 * @param width,height  原图尺寸
 * @param g,w,h         缩小后（长边 1000）的灰度
 * @returns { level: 'ok'|'yellow'|'red', problems: [{ level, rule, message }], stats }
 */
export function assessPhoto({ width, height }, g, w, h) {
  const problems = [];
  const short = Math.min(width, height);
  if (short < QC.minShort) problems.push({ level: 'red', rule: 'small', message: `太小（短边 ${short} 像素），请靠近一点重拍` });
  const blur = laplacianVariance(g, w, h);
  if (blur < QC.minBlur) problems.push({ level: 'red', rule: 'blur', message: '拍糊了，请拿稳、对好焦再拍' });
  const b = brightness(g);
  if (b.mean < QC.dark) problems.push({ level: 'red', rule: 'dark', message: '太暗了，请到亮一点的地方拍' });
  // 反光是灰纸面上一块发白的光斑。纸面本身（中位数）就接近纯白的是扫描件、截图或拍得很干净的照片，不算——
  // 按 PRD 的起始值"平均 > 230 或过曝 > 5%"判，干净的扫描件整页都会被标红（浏览器实测照出来的）
  else if (b.median < QC.bright + 15 && b.overexposed > QC.overexposed) problems.push({ level: 'red', rule: 'glare', message: '有反光（一块发白），请换个角度、避开灯光' });
  const skew = skewAngle(g, w, h);
  if (Math.abs(skew) > QC.maxSkew) problems.push({ level: 'yellow', rule: 'skew', message: `拍歪了（约 ${Math.abs(skew)}°），看得清就能继续` });
  const edges = edgeText(g, w, h);
  if (edges.length) problems.push({ level: 'yellow', rule: 'edge', message: `${edges.map((e) => SIDE[e]).join('、')}边上可能被裁掉了，看看字有没有拍全` });
  const level = problems.some((p) => p.level === 'red') ? 'red' : problems.length ? 'yellow' : 'ok';
  return { level, problems, stats: { short, blur: Math.round(blur), mean: Math.round(b.mean), overexposed: b.overexposed, skew, edges } };
}

/** 浏览器里：读一张照片，缩到长边 1000 算质检。 */
export async function assessFile(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, QC.analyzeLong / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close?.();
  const g = toGray(ctx.getImageData(0, 0, w, h).data, w, h);
  return { ...size, ...assessPhoto(size, g, w, h) };
}

/**
 * 上传用的图：已经是 JPEG、长边不超过 maxLong、不大于 3MB 的原样传（不再压一遍、不损画质），
 * 其余压到长边 maxLong 的 JPEG（拍板：2400）。
 */
export async function prepareUpload(file, maxLong = 2400) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const long = Math.max(bmp.width, bmp.height);
  if (file.type === 'image/jpeg' && long <= maxLong && file.size <= 3 * 1024 * 1024) {
    bmp.close?.();
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^;,]*;base64,/, 'data:image/jpeg;base64,'));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }
  const scale = Math.min(1, maxLong / long);
  const cv = document.createElement('canvas');
  cv.width = Math.round(bmp.width * scale);
  cv.height = Math.round(bmp.height * scale);
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height);
  bmp.close?.();
  return cv.toDataURL('image/jpeg', 0.85);
}
