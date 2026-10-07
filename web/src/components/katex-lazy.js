// KaTeX 和它的样式单独打成一块，只在题干里真有公式时才被取（CR L1，见 rich-text.jsx）。
// 这一行 import 的样式会跟着这一块一起按需加载，不进首屏的样式表。
import katex from 'katex';
import 'katex/dist/katex.min.css';

export default katex;
