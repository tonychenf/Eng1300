// PDF 拆成每页一张图（改进阶段 2 第三期，拍板 6：能直接传 PDF）。只在导入页按需加载 pdf.js，
// 学员那一路的脚本里没有它（ui-bio-exam 盯着"学员下载的脚本里没有后台代码"）。
// 每页按长边 2400 渲染成 JPEG（和照片同一个压缩尺寸），之后和照片走同一套质检、上传。
// isEvalSupported: false——页面的 CSP 不许 eval，pdf.js 默认会用 new Function 加速字体。
export async function pdfToImages(file, { maxLong = 2400, maxPages = 50 } = {}) {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false }).promise;
  const base = file.name.replace(/\.pdf$/i, '');
  const n = Math.min(doc.numPages, maxPages);
  const files = [];
  for (let i = 1; i <= n; i++) {
    const page = await doc.getPage(i);
    const v1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: maxLong / Math.max(v1.width, v1.height) });
    const cv = document.createElement('canvas');
    cv.width = Math.round(vp.width);
    cv.height = Math.round(vp.height);
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, cv.width, cv.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    const blob = await new Promise((r) => cv.toBlob(r, 'image/jpeg', 0.9));
    files.push(new File([blob], `${base}-第${i}页.jpg`, { type: 'image/jpeg' }));
    page.cleanup();
  }
  await doc.destroy();
  return { files, total: doc.numPages };
}
