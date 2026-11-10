// 识别之后的自动体检（PRD P3-C3 第二道关）。第二期的识别实测拿它算"体检能把多少错找出来"，第三期导入时复用。
// 纯函数，输入识别出的文字（按行），输出可疑的行和原因。
//
// 这一版有五条规则：页码对不上、题号跳号或重号、选项不齐、乱码、整页字数偏少。
// PRD 里的"不成词"（拼写检查）要随附一份五万词的词表，第三期再加；双重识别、做题反查要再调模型，也在第三期。
import { parseQuestions, normalizeLine } from './ocr-metrics.js';

// 替换符、控制字符、方框（提示词让模型看不清的字写 □）
const GARBLED = /[�\u0000-\u0008\u000B\u000C\u000E-\u001F□■]/;

export function runChecks(text, { expectedPage = null, expectOptions = false, minChars = 0 } = {}) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const flags = [];
  const flag = (line, rule, message) => flags.push({ line, rule, message });

  // 页码：识别出了书上印的页码、又和对上的那一页（或那一篇跨的几页）不一样
  if (expectedPage != null) {
    const want = (Array.isArray(expectedPage) ? expectedPage : [expectedPage]).map(Number);
    lines.forEach((ln, i) => {
      for (const m of String(ln).matchAll(/·\s*(\d{2,3})\s*·/g)) {
        if (!want.includes(Number(m[1]))) flag(i, 'page', `识别出的页码是 ${m[1]}，内容对上的是第 ${want.join('、')} 页`);
      }
    });
  }

  const qs = parseQuestions(lines);
  for (let k = 1; k < qs.length; k++) {
    const a = qs[k - 1].no;
    const b = qs[k].no;
    if (b === a) flag(qs[k].line, 'number', `题号 ${b} 重复了`);
    // 新的大题从第 1 题重新编号（样卷里拼写、词组、选择各从 1 起）是正常的
    else if (b !== a + 1 && b !== 1) flag(qs[k].line, 'number', `题号从 ${a} 跳到了 ${b}`);
  }
  if (expectOptions) {
    for (const q of qs) {
      if (q.letters.size !== 4) {
        const lack = ['A', 'B', 'C', 'D'].filter((x) => !q.letters.has(x));
        // 漏掉的多半在选项那几行，不在题号那一行：整道题的几行都标上
        for (let l = q.line; l <= q.endLine; l++) flag(l, 'options', `第 ${q.no} 题的选项不齐（缺 ${lack.join('、') || '—'}）`);
      }
    }
  }

  lines.forEach((ln, i) => {
    if (GARBLED.test(ln)) flag(i, 'garbled', '有乱码或看不清的字');
  });

  if (minChars > 0) {
    const chars = lines.reduce((n, ln) => n + normalizeLine(ln).length, 0);
    if (chars < minChars) {
      // 整页偏少（可能漏了半页）：整页都算可疑，核对时整页看
      lines.forEach((_, i) => flag(i, 'short', `这一页只识别出 ${chars} 个字，比同一批的一半还少，可能漏了内容`));
    }
  }
  return flags;
}
