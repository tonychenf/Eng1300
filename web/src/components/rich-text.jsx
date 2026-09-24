// 题干渲染：图片引用与公式（需求文档 §6.4.6）。题干、选项、逐项答案共用这一个。
//
// KaTeX 是本项目**唯一一个必须引入的前端库**（连 Tailwind 都没用，CSS 全手写）。
// 引它的理由只有一个：公式排版没法手写，不引理科就上不了。
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { tokenize } from '../lib/rich-text.js';

function mathHtml(tex, display) {
  // throwOnError:false —— 写错的公式渲染成一段红字，而不是把整页炸掉。
  // 红字是看得见的失败；抛异常会让整道题连题干都不显示，反而更难查。
  return katex.renderToString(tex, { displayMode: display, throwOnError: false });
}

function Asset({ asset, keyName }) {
  if (!asset) {
    // 发布校验会拦住"引用了不存在的资源"的题（§6.4.6 G2）。真漏到这里，
    // 也要让它看得见——悄悄渲染成空白的话，学生看到的是一道少了图的题。
    return <span className="badge danger">图缺失：{keyName}</span>;
  }
  if (asset.kind === 'AUDIO') {
    return <audio controls src={`/bank/${asset.path}`} style={{ maxWidth: '100%' }} />;
  }
  const img = (
    <img
      src={`/bank/${asset.path}`}
      // alt 必填（§6.4.6）。它同时是读屏的内容、图裂时的替代文本，
      // 以及喂给 AI 的那句 [图：alt]——三处用的是同一个字段。
      alt={asset.alt || ''}
      loading="lazy"
      className="q-figure-img"
    />
  );
  if (!asset.caption) return img;
  return (
    <figure className="q-figure">
      {img}
      <figcaption className="tiny muted">{asset.caption}</figcaption>
    </figure>
  );
}

/**
 * 一段带标记的文本。
 * @param assets [{key, kind, path, alt, caption}]，没有就当这段文本里没有图
 */
export function RichText({ text, assets, className, style }) {
  const byKey = new Map((assets || []).map((a) => [a.key, a]));
  const parts = tokenize(text);
  // 没有任何标记时走原来那条路：一个普通的 <span>，不引入任何额外结构。
  // 英语 1020 道题全在这条路上，改造不该让它们的 DOM 变一个样。
  if (parts.every((p) => p.type === 'text')) {
    return <span className={className} style={style}>{String(text ?? '')}</span>;
  }
  return (
    <span className={className} style={style}>
      {parts.map((p, i) => {
        if (p.type === 'text') return <span key={i}>{p.value}</span>;
        if (p.type === 'image') return <Asset key={i} asset={byKey.get(p.key)} keyName={p.key} />;
        // 块级公式可能比屏幕宽。让它自己横向滚，不要把整页撑出横向滚动条——
        // 手机上页面级横向滚动是硬要求里明确不许的那一条。
        return (
          <span
            key={i}
            className={p.display ? 'math-block' : 'math-inline'}
            dangerouslySetInnerHTML={{ __html: mathHtml(p.value, p.display) }}
          />
        );
      })}
    </span>
  );
}
