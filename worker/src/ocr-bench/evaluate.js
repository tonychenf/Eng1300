// 识别实测：一张图的识别结果 → 指标（字符准确率、题目完整率、体检检出率 / 误报率、出错的地方）。
// 浏览器里算（理由见 lib/ocr-metrics.js 顶部），算完把结果存回服务端。
//
// 照片不用标页码（用户 2026-11-10：什么图都该能测，比对不该要人选）：识别出来的文字自己去仓库的人工转写稿里找
// 对得上的那一页（matchReference）。对上了逐字算准确率；对不上（别的学科、别的资料、转写稿里没有的页）就只给体检，
// 页面把原图和各模型的结果并排放、模型之间说法不一样的行标出来（ocr-metrics.js 的 agreement），人对着图看。
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

// 能拿来比的参照：选择题一页一份；教学重点、样卷的转写稿一篇跨几页、分不出页界，一篇一份（半全局比）
export const REFERENCES = (() => {
  const refs = [];
  const docs = new Set();
  for (const p of TRUTH_PAGES) {
    if (p.kind === 'mc') {
      refs.push({ key: `page-${p.page}`, kind: 'mc', pages: [p.page], label: `第 ${p.page} 页 · ${p.label}`, text: p.text, questions: p.questions });
    } else if (!docs.has(p.doc)) {
      docs.add(p.doc);
      const pages = TRUTH_PAGES.filter((x) => x.doc === p.doc).map((x) => x.page);
      refs.push({ key: p.doc, kind: 'doc', pages, label: `第 ${pages[0]}–${pages[pages.length - 1]} 页 · ${p.label.replace(/（整.比对）$/, '')}`, text: DOCS[p.doc] });
    }
  }
  return refs;
})();

const GRAM = 3;
const gramCache = new Map();
function gramsOf(s) {
  const set = new Set();
  for (let k = 0; k + GRAM <= s.length; k++) set.add(s.slice(k, k + GRAM));
  return set;
}
function refGrams(ref) {
  if (!gramCache.has(ref.key)) {
    const T = normalizeText(ref.text);
    gramCache.set(ref.key, { T, grams: gramsOf(T.s) });
  }
  return gramCache.get(ref.key);
}

// 对上的门槛：识别结果里的三字片段至少 30% 出现在这份转写稿里（先粗筛，便宜），再逐字比准确率不低于 50%。
// 不是这页的东西逐字比出来在 10%–40%（选择题页之间、英语和别的英语材料之间，单测里量过）；
// 是这页、但模型认得很差的，宁可当"没对上"让人看图，也不拿一份错配的标准答案去算准确率。
export const MATCH = { minContainment: 0.3, minAccuracy: 0.5, minChars: 30 };

/**
 * 识别出来的文字是转写稿里的哪一页。
 * @returns { ref, accuracy, containment } 或 null（对不上）。只拿粗筛最像的两份去逐字比。
 */
export function matchReference(recognized) {
  const R = normalizeText(recognized);
  if (R.s.length < MATCH.minChars) return null;
  const rg = gramsOf(R.s);
  if (!rg.size) return null;
  const scored = REFERENCES.map((ref) => {
    const { grams } = refGrams(ref);
    let hit = 0;
    for (const g of rg) if (grams.has(g)) hit++;
    return { ref, containment: hit / rg.size };
  }).sort((a, b) => b.containment - a.containment).slice(0, 2).filter((x) => x.containment >= MATCH.minContainment);
  let best = null;
  for (const c of scored) {
    const accuracy = scoreAgainst(R, c.ref).accuracy;
    if (accuracy >= MATCH.minAccuracy && (!best || accuracy > best.accuracy)) best = { ...c, accuracy };
  }
  return best;
}

function scoreAgainst(R, ref) {
  const { T } = refGrams(ref);
  const a = align(R.s, T.s, { freeEnds: ref.kind === 'doc' });
  const denom = ref.kind === 'doc' ? a.tEnd - a.tStart : T.s.length;
  return { a, denom, accuracy: denom > 0 ? Math.max(0, 1 - a.dist / denom) : 0 };
}

/** 题目像不像选择题（认出 3 道以上、多半带选项）：像就按"选项要齐"体检。没有参照时用。 */
function looksLikeChoice(lines) {
  const qs = parseQuestions(lines);
  return qs.length >= 3 && qs.filter((q) => q.letters.size > 0).length * 2 >= qs.length;
}

/**
 * 一份识别结果对一份参照算指标；ref 为 null（转写稿里没有）时只给体检。
 * @param minChars  同一批识别里"字数偏少"的线（中位数的一半），算不出来传 0
 */
export function evaluateRef(recognized, ref, { minChars = 0 } = {}) {
  const R = normalizeText(recognized);
  const flags = runChecks(recognized, {
    expectedPage: ref ? ref.pages : null,
    expectOptions: ref ? ref.kind === 'mc' : looksLikeChoice(R.lines),
    minChars,
  });
  const base = { chars: R.s.length, flags, ref: ref ? { key: ref.key, label: ref.label, pages: ref.pages, kind: ref.kind } : null };
  if (!ref) return { ...base, unavailable: '转写稿里没有这一页：对着原图看，几个模型说法不一样的行标出来了' };

  const { a, denom, accuracy } = scoreAgainst(R, ref);
  const errLines = new Set();
  for (let k = 0; k < R.s.length; k++) if (a.errAt[k]) errLines.add(R.lineOf[k]);
  const det = detection([...errLines], flags.map((f) => f.line));
  const comp = ref.kind === 'mc' ? completeness(ref.questions, parseQuestions(R.lines)) : null;
  return {
    ...base,
    page: ref.pages[0],
    label: ref.label,
    kind: ref.kind,
    accuracy,
    dist: a.dist,
    denom,
    edits: { subs: a.subs, ins: a.ins, dels: a.dels },
    completeness: comp && { ok: comp.ok, total: comp.total, rate: comp.rate, missing: comp.missing },
    detection: det,
    errLines: [...errLines].sort((x, y) => x - y),
    // 出错的行（最多 8 行），报告里给人看"错在哪类地方"
    errorSamples: [...errLines].sort((x, y) => x - y).slice(0, 8)
      .map((l) => ({ line: l + 1, text: String(R.lines[l] ?? '').slice(0, 120), flagged: flags.some((f) => f.line === l) })),
  };
}

/** 原书第几页的那份参照（选择题页就是那一页，教学重点、样卷是那一篇）；转写稿里没有返回 null。 */
export function referenceForPage(page) {
  return REFERENCES.find((r) => r.pages.includes(Number(page))) || null;
}

/** 按原书页码比（单测、以前标了页码的实测用）。 */
export function evaluate(recognized, page, opts = {}) {
  const ref = referenceForPage(page);
  const e = evaluateRef(recognized, ref, opts);
  if (!ref) {
    const t = truthFor(page);
    return { ...e, page: Number(page), label: null, unavailable: t.unavailable };
  }
  return e;
}

/** 一批识别结果的"字数偏少"线：同一模型、同一尺寸的各页字数中位数的一半。 */
export function shortLine(charCounts) {
  const xs = charCounts.filter((n) => n > 0).sort((a, b) => a - b);
  if (xs.length < 3) return 0;   // 页数太少，中位数说明不了什么，不判
  return Math.floor(xs[Math.floor(xs.length / 2)] / 2);
}
