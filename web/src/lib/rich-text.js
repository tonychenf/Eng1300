// 题干的标记切分（需求文档 §6.4.6）。**纯函数，不碰 React**——
// 它要能被 node 单测直接 import，拿真实题库跑一遍看有没有被误判成公式的文本。
//
// 两种标记：
//   `![key]`        引用本题的一个资源，渲染成图
//   `$...$` `$$...$$`  行内／块级公式，前端交给 KaTeX
//
// **判分不解析这两种标记**（§6.4.6 末尾、G5）：答案比对仍是字符串归一化，
// 所以 `$\frac{1}{2}$` 和 `$0.5$` 判不等价。这是有意的，不是没做完。

const IMAGE_RE = /^!\[([A-Za-z0-9_-]+)\]/;

// 行内公式的闭界符规则。这不是吹毛求疵——英语真题的阅读原文里就有
// `$0.79, $0.99 and $1.49` 和 `$300 per month ... $400 per month`：
// 按"两个 $ 之间就是公式"来切，这些价格会被当成公式，整段原文当场变形。
// 规则是通行的那套（markdown-it-katex 同款）：
//   - 开界符后面不能是空白（`$ x` 不开公式）
//   - 闭界符前面不能是空白（`$0.79, $0.99` 里第二个 $ 前面是空格，不闭合）
//   - 闭界符后面不能紧跟数字（挡住 `$5-$10`）
//   - 公式里不许跨行（挡住"上一段一个 $、下一段一个 $"连成一大坨）
function findInlineClose(text, from) {
  for (let j = from; j < text.length; j++) {
    if (text[j] !== '$') continue;
    if (text[j - 1] === '\\') continue;
    if (/\s/.test(text[j - 1])) continue;
    if (/\d/.test(text[j + 1] || '')) continue;
    if (j === from) continue;
    if (text.slice(from, j).includes('\n')) return -1;
    return j;
  }
  return -1;
}

/**
 * 切成 [{type:'text'|'math'|'image', ...}]。
 * 认不出的标记原样留在 text 里——宁可少渲染一个东西，也不要把普通文本吃掉。
 */
export function tokenize(raw) {
  const text = String(raw ?? '');
  const out = [];
  let buf = '';
  let i = 0;
  const flush = () => { if (buf) { out.push({ type: 'text', value: buf }); buf = ''; } };

  while (i < text.length) {
    if (text[i] === '!' && text[i + 1] === '[') {
      const m = IMAGE_RE.exec(text.slice(i));
      if (m) { flush(); out.push({ type: 'image', key: m[1] }); i += m[0].length; continue; }
    }
    if (text[i] === '$') {
      if (text[i + 1] === '$') {
        const end = text.indexOf('$$', i + 2);
        if (end > i + 2) {
          flush();
          out.push({ type: 'math', value: text.slice(i + 2, end), display: true });
          i = end + 2;
          continue;
        }
      } else if (text[i + 1] && !/\s/.test(text[i + 1])) {
        const close = findInlineClose(text, i + 1);
        if (close > 0) {
          flush();
          out.push({ type: 'math', value: text.slice(i + 1, close), display: false });
          i = close + 1;
          continue;
        }
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

/** 这段文本里有没有需要特殊渲染的东西。没有就走原来那条纯文本路径。 */
export function hasMarkup(text) {
  return tokenize(text).some((t) => t.type !== 'text');
}
