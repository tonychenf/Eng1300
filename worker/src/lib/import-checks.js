// AI 拆题导入的第二道关：自动体检（改进阶段 2 第三期，PRD P3-C3）。纯函数，没有 I/O。
//
// 输入是拆好的草稿（draft.sections[].questions[]）和各页的识别结果，输出可疑处清单。
// 每处可疑有一个稳定的 id（规则 + 位置），核对时点"没问题"记的就是这个 id——改了字重新体检，
// 同一处问题 id 不变，已经点过的不用再点；问题没了，它自然从清单里消失。
//
// 这一版的规则：页码连续、题号连续、选项齐全、题量对得上、段落填空的空号、乱码、字数偏少、第二遍识别不一致。
// PRD 里的"不成词"要随附一份五万词的词表（Worker 包体积有上限），先不做；做题反查、手写答案比对在出答案那一步（D）。
// 替换符、控制字符、方框（提示词让模型看不清的字写 □）
const GARBLED = /[�\u0000-\u0008\u000B\u000C\u000E-\u001F□■]/;
const LETTERS = ['A', 'B', 'C', 'D'];

/** 一页识别出的文字当场能查的几条（决定要不要趁图还在再识别一遍）。 */
export function pageQuickIssues(text, { minChars = 0 } = {}) {
  const out = [];
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  lines.forEach((ln, i) => { if (GARBLED.test(ln)) out.push({ rule: 'garbled', line: i, message: `第 ${i + 1} 行有乱码或看不清的字` }); });
  const chars = lines.join('').replace(/\s+/g, '').length;
  if (chars < 30) out.push({ rule: 'empty', message: `这一页只认出 ${chars} 个字` });
  else if (minChars > 0 && chars < minChars) out.push({ rule: 'short', message: `这一页只认出 ${chars} 个字，比别的页少很多，可能漏了内容` });
  return out;
}

/** 选项里出现的字母（"A. xxx" / "A) xxx" / "（A）xxx"）。 */
export function optionLetters(options) {
  return (options || []).map((o) => {
    const m = String(o).normalize('NFKC').match(/^\s*\(?([A-Za-z])\s*[).．.、:：]/);
    return m ? m[1].toUpperCase() : null;
  });
}

/** 段落里出现的空号：(21)、( 21 )、__21__、21. ____ 这几种写法。 */
export function blankNumbers(passage) {
  const s = String(passage || '').normalize('NFKC');
  const nos = new Set();
  for (const m of s.matchAll(/\(\s*(\d{1,3})\s*\)/g)) nos.add(Number(m[1]));
  for (const m of s.matchAll(/_{2,}\s*(\d{1,3})\s*_{2,}/g)) nos.add(Number(m[1]));
  for (const m of s.matchAll(/(?:^|\s)(\d{1,3})\s*[.．]\s*_{2,}/g)) nos.add(Number(m[1]));
  return [...nos].sort((a, b) => a - b);
}

function median(xs) {
  const s = xs.filter((n) => n > 0).sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
}

/**
 * 整份草稿的体检。
 * @param draft   { sections: [{ type, title, passage, printedCount, questions: [{ id, no, questionType, stem, options, pageNo }] }] }
 * @param pages   [{ pageNo, printedPage, text, textAlt, status }]（按上传顺序）
 * @param types   { [type_code]: { widget, strategy } }（本学科的题型声明）
 * @returns issues [{ id, rule, level: 'red'|'yellow', scope, pageNo?, qid?, sectionIdx?, message }]
 */
export function checkDraft(draft, pages = [], types = {}) {
  const issues = [];
  const add = (id, rule, scope, message, extra = {}) => issues.push({ id, rule, scope, level: extra.level || 'yellow', message, ...extra });

  // 页码连续：识别出的印刷页码按上传顺序应当一页一页往上加
  const printed = pages.filter((p) => Number.isInteger(p.printedPage));
  for (let k = 1; k < printed.length; k++) {
    const a = printed[k - 1];
    const b = printed[k];
    const want = a.printedPage + (b.pageNo - a.pageNo);
    if (b.printedPage === a.printedPage) add(`page-dup:${b.pageNo}`, 'page', 'page', `第 ${b.pageNo} 张照片和第 ${a.pageNo} 张印的都是第 ${b.printedPage} 页，是不是拍重了`, { pageNo: b.pageNo });
    else if (b.printedPage < a.printedPage) add(`page-order:${b.pageNo}`, 'page', 'page', `第 ${b.pageNo} 张照片印的是第 ${b.printedPage} 页，排在第 ${a.printedPage} 页后面，顺序是不是反了`, { pageNo: b.pageNo });
    else if (b.printedPage > want) {
      const miss = [];
      for (let x = want; x < b.printedPage && miss.length < 10; x++) miss.push(x);
      add(`page-gap:${b.pageNo}`, 'page', 'job', `缺第 ${miss.join('、')} 页（第 ${a.pageNo}、${b.pageNo} 张照片之间），要补拍吗`, { pageNo: b.pageNo });
    }
  }

  // 失败的页
  for (const p of pages) {
    if (p.status === '失败') add(`page-failed:${p.pageNo}`, 'failed', 'page', `第 ${p.pageNo} 张照片识别失败${p.error ? `（${p.error}）` : ''}，请重拍这一页`, { pageNo: p.pageNo, level: 'red' });
  }

  // 每页：乱码、字数偏少（不是最后一页）、第二遍识别不一致
  const med = median(pages.map((p) => String(p.text || '').replace(/\s+/g, '').length));
  const lastNo = pages.length ? Math.max(...pages.map((p) => p.pageNo)) : 0;
  for (const p of pages) {
    if (p.status !== '已识别') continue;
    const lines = String(p.text || '').split('\n');
    lines.forEach((ln, i) => {
      if (GARBLED.test(ln)) add(`garbled:${p.pageNo}:${i}`, 'garbled', 'page', `第 ${p.pageNo} 张照片第 ${i + 1} 行有乱码或看不清的字：${ln.slice(0, 40)}`, { pageNo: p.pageNo, line: i });
    });
    const chars = String(p.text || '').replace(/\s+/g, '').length;
    if (med > 0 && chars < med / 2 && p.pageNo !== lastNo) {
      add(`short:${p.pageNo}`, 'short', 'page', `第 ${p.pageNo} 张照片只认出 ${chars} 个字，不到其他页的一半，可能漏了内容`, { pageNo: p.pageNo });
    }
    for (const [i, d] of (p.altDiffs || []).entries()) {
      add(`alt:${p.pageNo}:${i}`, 'double', 'page', `第 ${p.pageNo} 张照片两次识别不一致：「${d.a}」/「${d.b}」`, { pageNo: p.pageNo });
    }
  }

  // 每个大题：题号连续、题量对得上、选项齐全、段落填空的空号
  let prevLast = null;
  for (const [si, s] of (draft.sections || []).entries()) {
    const qs = s.questions || [];
    const where = `第 ${si + 1} 部分「${s.title || s.type}」`;
    // 和前一道**认出了题号**的比：一道没认出题号的题只报它自己，不连带把下一道报成"不是从 1 开始"
    // 中间没认出题号的题各占一个号：1、（没认出）、3 不算跳号
    let prevNo = null;
    let seen = false;
    let unnumbered = 0;
    for (let k = 0; k < qs.length; k++) {
      const q = qs[k];
      if (!Number.isInteger(q.no)) {
        add(`no-missing:${q.id}`, 'number', 'question', `${where}有一道题没认出题号`, { qid: q.id, sectionIdx: si, pageNo: q.pageNo });
        seen = true;
        unnumbered++;
        continue;
      }
      if (prevNo === null && seen) { prevNo = q.no; unnumbered = 0; continue; }
      if (prevNo === null) {
        // 新的一部分从 1 开始，或者接着上一部分往下编（同一套题跨了大题）
        if (q.no !== 1 && !(prevLast !== null && q.no === prevLast + 1)) {
          add(`no-start:${q.id}`, 'number', 'question', `${where}第一题题号是 ${q.no}，不是从 1 开始，前面是不是漏了`, { qid: q.id, sectionIdx: si, pageNo: q.pageNo });
        }
      } else if (q.no === prevNo) {
        add(`no-dup:${q.id}`, 'number', 'question', `${where}题号 ${q.no} 重复了`, { qid: q.id, sectionIdx: si, pageNo: q.pageNo });
      } else if (q.no !== prevNo + 1 + unnumbered) {
        add(`no-gap:${q.id}`, 'number', 'question', `${where}题号从 ${prevNo} 跳到了 ${q.no}`, { qid: q.id, sectionIdx: si, pageNo: q.pageNo });
      }
      prevNo = q.no;
      seen = true;
      unnumbered = 0;
    }
    const lastKnown = [...qs].reverse().find((q) => Number.isInteger(q.no));
    if (lastKnown) prevLast = lastKnown.no;
    if (Number.isInteger(s.printedCount) && s.printedCount > 0 && s.printedCount !== qs.length) {
      add(`count:${si}`, 'count', 'section', `${where}书上写 ${s.printedCount} 题，认出了 ${qs.length} 题`, { sectionIdx: si, pageNo: qs[0]?.pageNo });
    }
    for (const q of qs) {
      const t = types[q.questionType];
      if (!t) {
        add(`type:${q.id}`, 'type', 'question', `第 ${q.no} 题的题型「${q.questionType}」这门课没有`, { qid: q.id, sectionIdx: si, pageNo: q.pageNo, level: 'red' });
        continue;
      }
      if (t.widget === 'choice') {
        const letters = optionLetters(q.options);
        const lack = LETTERS.filter((x) => !letters.includes(x));
        const dup = letters.filter((x, i) => x && letters.indexOf(x) !== i);
        if ((q.options || []).length !== 4 || lack.length || dup.length) {
          add(`options:${q.id}`, 'options', 'question',
            `第 ${q.no} 题的选项不齐（认出 ${(q.options || []).length} 个${lack.length ? `，缺 ${lack.join('、')}` : ''}${dup.length ? `，${[...new Set(dup)].join('、')} 重复` : ''}）`,
            { qid: q.id, sectionIdx: si, pageNo: q.pageNo });
        }
      }
      if (!String(q.stem || '').trim() && !(q.options || []).length) {
        add(`stem:${q.id}`, 'stem', 'question', `第 ${q.no} 题题干是空的`, { qid: q.id, sectionIdx: si, pageNo: q.pageNo });
      }
    }
    // 段落填空：原文里的空号集合 = 题号集合
    const blanks = blankNumbers(s.passage);
    if (s.passage && blanks.length >= 3) {
      const nos = new Set(qs.map((q) => q.no));
      const notInQs = blanks.filter((b) => !nos.has(b));
      const notInPassage = [...nos].filter((n) => !blanks.includes(n));
      if (notInQs.length || notInPassage.length) {
        add(`blanks:${si}`, 'blanks', 'section',
          `${where}原文里的空号和题号对不上${notInQs.length ? `：原文有第 ${notInQs.join('、')} 空，题里没有` : ''}${notInPassage.length ? `${notInQs.length ? '；' : '：'}第 ${notInPassage.join('、')} 题在原文里找不到空` : ''}`,
          { sectionIdx: si, pageNo: qs[0]?.pageNo });
      }
    }
  }
  return issues;
}

/** 两次识别逐行比，挑出不一致的片段（最多 10 处），给核对页看。 */
export function altDiffs(a, b) {
  const norm = (s) => String(s || '').split('\n').map((x) => x.replace(/\s+/g, '')).filter(Boolean);
  const A = norm(a);
  const B = new Set(norm(b));
  const Bl = norm(b);
  const out = [];
  for (const [i, ln] of A.entries()) {
    if (B.has(ln)) continue;
    out.push({ a: ln.slice(0, 60), b: (Bl[i] || '').slice(0, 60) });
    if (out.length >= 10) break;
  }
  return out;
}

