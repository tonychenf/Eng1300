// 识别结果和标准答案逐字比（改进阶段 2 第二期「识别实测」，第三期导入时复用）。纯函数，没有 I/O。
//
// 算在浏览器里，不在 Worker 里：一页 2000 字 × 标准答案 7000 字的编辑距离是一千多万次比较，
// Worker 每次请求的 CPU 时间放不下；管理员的手机、电脑算这个不到一秒。
//
// 指标定义见 PRD P2-3：
//   字符准确率 = 1 − 编辑距离 / 标准字数。比之前两边做同样的规整：去掉所有空白、全角半角统一、中文标点换成英文、
//               连续下划线并成一个、选项标号（A. A、（A））统一成 A)、去掉页眉页脚的页码（·123·）。
//   题目完整率 = 标准答案这一页的题，在识别结果里按题号找得到、并且 A–D 四个选项齐全的比例。
// 整课 / 整卷比对的页（教学重点、样卷）标准答案比这一页长，用"半全局"比对：在标准答案里找和这一页最像的那一段，
// 两头没对上的部分不算错。

const PUNCT = {
  '，': ',', '。': '.', '；': ';', '：': ':', '（': '(', '）': ')', '！': '!', '？': '?',
  '“': '"', '”': '"', '‘': "'", '’': "'", '—': '-', '–': '-', '、': ',', '【': '[', '】': ']',
};

/** 一行规整成比对用的形状。 */
export function normalizeLine(line) {
  let s = String(line ?? '').normalize('NFKC');
  s = s.replace(/·\s*\d{1,3}\s*·/g, '');                 // 页码 ·123·
  s = s.replace(/[，。；：（）！？“”‘’—–、【】]/g, (c) => PUNCT[c]);
  s = s.replace(/…/g, '...');
  s = s.replace(/\s+/g, '');
  s = s.replace(/_+/g, '_');
  s = s.replace(/\(?([A-D])[).,](?=\S)/g, '$1)');           // A. / A、/ (A) → A)
  s = s.replace(/^(\d{1,3}),/, '$1.');                      // 题号 1、→ 1.
  return s;
}

/** 整段规整，并记下规整后每个字来自第几行（体检和找错的位置都按行）。 */
export function normalizeText(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  let s = '';
  const lineOf = [];
  lines.forEach((ln, i) => {
    const n = normalizeLine(ln);
    s += n;
    for (let k = 0; k < n.length; k++) lineOf.push(i);
  });
  return { s, lineOf, lines };
}

/**
 * 编辑距离对齐（带回溯）。freeEnds = true 时是半全局：标准答案 t 两头没对上的部分不计代价，
 * 返回对上的那一段 [tStart, tEnd)。r 里哪些位置出了错记在 errAt（替换、多出来的字记在它自己的位置，
 * 漏掉的字记在它该出现的那个位置前面一个字上）。
 */
export function align(r, t, { freeEnds = false } = {}) {
  const n = r.length;
  const m = t.length;
  const W = m + 1;
  const dir = new Uint8Array((n + 1) * W);   // 0 对上 1 替换 2 r 多一个字 3 r 漏一个字
  let prev = new Int32Array(W);
  let cur = new Int32Array(W);
  for (let j = 0; j <= m; j++) { prev[j] = freeEnds ? 0 : j; dir[j] = 3; }
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    dir[i * W] = 2;
    const ri = r.charCodeAt(i - 1);
    const row = i * W;
    for (let j = 1; j <= m; j++) {
      const same = ri === t.charCodeAt(j - 1);
      let best = prev[j - 1] + (same ? 0 : 1);
      let d = same ? 0 : 1;
      const up = prev[j] + 1;
      if (up < best) { best = up; d = 2; }
      const left = cur[j - 1] + 1;
      if (left < best) { best = left; d = 3; }
      cur[j] = best;
      dir[row + j] = d;
    }
    const tmp = prev; prev = cur; cur = tmp;
  }
  let j = m;
  let dist = prev[m];
  if (freeEnds) {
    for (let k = 0; k <= m; k++) if (prev[k] < dist) { dist = prev[k]; j = k; }
  }
  const tEnd = j;
  const errAt = new Uint8Array(Math.max(n, 1));
  let subs = 0, ins = 0, dels = 0;
  let i = n;
  while (i > 0 || (!freeEnds && j > 0)) {
    const d = i === 0 ? 3 : (j === 0 ? 2 : dir[i * W + j]);
    if (d === 0) { i--; j--; }
    else if (d === 1) { subs++; errAt[i - 1] = 1; i--; j--; }
    else if (d === 2) { ins++; errAt[i - 1] = 1; i--; }
    else { dels++; errAt[Math.max(0, i - 1)] = 1; j--; }
  }
  return { dist, tStart: freeEnds ? j : 0, tEnd, subs, ins, dels, errAt };
}

const Q_START = /^\s*(\d{1,3})\s*[.．、,，]\s*\S/;
const OPT = /(?:^|[\s(（])([A-D])\s*[)）.．、]/g;

/** 从识别出的文字里认题：题号 + 这道题下面出现了哪几个选项字母。 */
export function parseQuestions(lines) {
  const qs = [];
  lines.forEach((raw, idx) => {
    const ln = String(raw).normalize('NFKC');
    const m = ln.match(Q_START);
    if (m) qs.push({ no: Number(m[1]), line: idx, endLine: idx, letters: new Set() });
    const cur = qs[qs.length - 1];
    if (!cur) return;
    cur.endLine = idx;   // 这道题占到第几行（下一题之前）：选项不齐时整道题的几行都可疑
    // 题号那一行的题干里也可能有选项（选项排在同一行），所以整行都扫
    for (const o of ln.matchAll(OPT)) cur.letters.add(o[1]);
  });
  return qs;
}

/** 题目完整率：标准答案这一页的题号，在识别结果里找得到、A–D 齐全的有几道。 */
export function completeness(expectedNos, parsed) {
  const byNo = new Map();
  for (const q of parsed) if (!byNo.has(q.no)) byNo.set(q.no, q);
  const missing = [];
  let ok = 0;
  for (const no of expectedNos) {
    const q = byNo.get(no);
    if (q && q.letters.size === 4) ok++;
    else missing.push(no);
  }
  return { ok, total: expectedNos.length, rate: expectedNos.length ? ok / expectedNos.length : null, missing };
}

/** 体检报出的行 vs 实际有错的行：检出率、误报率（PRD P2-3）。 */
export function detection(errLines, flagLines) {
  const err = new Set(errLines);
  const flag = new Set(flagLines);
  let caught = 0;
  for (const l of err) if (flag.has(l)) caught++;
  let falsePos = 0;
  for (const l of flag) if (!err.has(l)) falsePos++;
  return {
    errLines: err.size, flagged: flag.size, caught, missed: err.size - caught, falsePos,
    detectRate: err.size ? caught / err.size : null,
    falsePosRate: flag.size ? falsePos / flag.size : null,
  };
}
