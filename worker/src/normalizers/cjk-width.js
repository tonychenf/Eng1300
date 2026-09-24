// 中文题面的字符归一化（需求文档 §5.4②）。**按能力注册，不按学科**——
// 全角半角、希腊字母、连字符变体这些事，任何有中文题面的学科都会遇到。
//
// 只做**同一个字符的不同写法**的折叠。明确不做的三件事（§5.4 点名）：
// 同音字替换、繁简转换、"氨"与"胺"互认。它们都会把不同的物质折到一起——
// `谷氨酸` 和 `谷胺酸` 只有一个是对的，折叠等于把错答放过。

// 全角 ASCII（！到～）与全角空格
function toHalfWidth(s) {
  return s.replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/　/g, ' ');
}

// 希腊字母的中文与拉丁写法。学生写「阿尔法螺旋」「alpha 螺旋」「α-螺旋」是同一个东西。
// 只收生化真会用到的这几个，不整张希腊字母表——没用到的条目是白白扩大折叠面。
const GREEK = [
  ['α', ['阿尔法', 'alpha']],
  ['β', ['贝塔', 'beta']],
  ['γ', ['伽马', '伽玛', 'gamma']],
  ['δ', ['德尔塔', 'delta']],
  ['ε', ['艾普西龙', 'epsilon']],
  ['κ', ['卡帕', 'kappa']],
  ['λ', ['兰姆达', 'lambda']],
  ['μ', ['缪', 'mu']],
  ['ω', ['欧米伽', '欧米茄', 'omega']],
];

// 连字符的各种变体：全角减号、破折号、连接号、非断行连字符
const HYPHENS = /[－‐‑‒–—―−]/g;

export function cjkWidth(raw) {
  let s = toHalfWidth(String(raw ?? ''));
  s = s.replace(HYPHENS, '-');
  for (const [letter, names] of GREEK) {
    for (const n of names) {
      // 中文名要整体替换；拉丁写法要求前后不是字母，免得把 alphabet 折成 αbet
      const re = n.charCodeAt(0) < 128
        ? new RegExp(`(^|[^a-z])${n}(?![a-z])`, 'gi')
        : new RegExp(n, 'g');
      s = n.charCodeAt(0) < 128 ? s.replace(re, (m, pre) => `${pre}${letter}`) : s.replace(re, letter);
    }
  }
  // 中文句读落在词尾时去掉：`半胱氨酸。` 与 `半胱氨酸` 是同一个答案。
  // 骨架的基础折叠只去 ASCII 标点，中文标点要在这里补。
  return s.replace(/^[，。；、：！？（）]+|[，。；、：！？（）]+$/g, '').trim();
}
