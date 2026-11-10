// 识别实测：一张图的识别结果 → 指标（字符准确率、题目完整率、体检检出率 / 误报率、出错的地方）。
// 浏览器里算（理由见 lib/ocr-metrics.js 顶部），算完把结果存回服务端。
import { TRUTH_PAGES, DOCS, UNAVAILABLE } from './truth-data.js';
import { normalizeText, align, parseQuestions, completeness, detection } from '../lib/ocr-metrics.js';
import { runChecks } from '../lib/ocr-checks.js';

export { TRUTH_PAGES, UNAVAILABLE };

/** 原书第几页的标准答案。没有转写稿的页返回 { page, unavailable }。 */
export function truthFor(page) {
  const p = TRUTH_PAGES.find((x) => x.page === Number(page));
  if (!p) return { page: Number(page), unavailable: UNAVAILABLE[page] || '这一页不在转写稿里' };
  return { ...p, text: p.text ?? DOCS[p.doc] };
}

/**
 * @param recognized  模型识别出的文字
 * @param page        原书页码（管理员标的）
 * @param minChars    同一批识别里"字数偏少"的线（中位数的一半），算不出来传 0
 */
export function evaluate(recognized, page, { minChars = 0 } = {}) {
  const t = truthFor(page);
  const R = normalizeText(recognized);
  const flags = runChecks(recognized, { expectedPage: Number(page), expectOptions: t.kind === 'mc', minChars });
  const base = { page: Number(page), label: t.label || null, chars: R.s.length, flags };
  if (t.unavailable) return { ...base, unavailable: t.unavailable };

  const T = normalizeText(t.text);
  const a = align(R.s, T.s, { freeEnds: t.kind === 'doc' });
  const denom = t.kind === 'doc' ? a.tEnd - a.tStart : T.s.length;
  const accuracy = denom > 0 ? Math.max(0, 1 - a.dist / denom) : 0;

  const errLines = new Set();
  for (let k = 0; k < R.s.length; k++) if (a.errAt[k]) errLines.add(R.lineOf[k]);
  const det = detection([...errLines], flags.map((f) => f.line));
  const comp = t.kind === 'mc' ? completeness(t.questions, parseQuestions(R.lines)) : null;

  return {
    ...base,
    kind: t.kind,
    accuracy,
    dist: a.dist,
    denom,
    edits: { subs: a.subs, ins: a.ins, dels: a.dels },
    completeness: comp && { ok: comp.ok, total: comp.total, rate: comp.rate, missing: comp.missing },
    detection: det,
    // 出错的行（最多 8 行），报告里给人看"错在哪类地方"
    errorSamples: [...errLines].sort((x, y) => x - y).slice(0, 8)
      .map((l) => ({ line: l + 1, text: String(R.lines[l] ?? '').slice(0, 120), flagged: flags.some((f) => f.line === l) })),
  };
}

/** 一批识别结果的"字数偏少"线：同一模型、同一尺寸的各页字数中位数的一半。 */
export function shortLine(charCounts) {
  const xs = charCounts.filter((n) => n > 0).sort((a, b) => a - b);
  if (xs.length < 3) return 0;   // 页数太少，中位数说明不了什么，不判
  return Math.floor(xs[Math.floor(xs.length / 2)] / 2);
}
