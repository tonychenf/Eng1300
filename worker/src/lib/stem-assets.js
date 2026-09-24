// 题干里的图片引用与公式（需求文档 §6.4.6）。
//
// `questions.stem` 从"纯文本"变成"带 ![key] 与 $...$ 标记的文本"：
//   - `![fig1]`  引用本题的一个资源（question_assets 里 asset_key = fig1 的那行）
//   - `$...$` / `$$...$$`  行内／块级公式，**判分不解析它**，只有前端渲染认得
//
// 这个模块是**唯一一处**解析这两种标记的地方：种子生成、发布校验、喂 AI 前的替换
// 都从这里走。两处各写一份正则的下场是可预见的——种子那边认得的写法发布那边不认，
// 于是题入了库、发布时被拒，而报错指向一个看起来毫无关系的地方。

/** 题干里引用图片的写法。key 只允许字母数字下划线连字符，免得和普通的方括号文本撞上。 */
export const ASSET_REF_RE = /!\[([A-Za-z0-9_-]+)\]/g;

export const ASSET_KINDS = ['IMAGE', 'AUDIO'];

function fail(code, message) {
  const err = new Error(`${code}: ${message}`);
  err.code = code;
  return err;
}

/** 一段文本里引用了哪些资源 key，按出现顺序去重。 */
export function assetRefsIn(text) {
  const out = [];
  for (const m of String(text ?? '').matchAll(ASSET_REF_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * 喂给 AI 之前的题干替换（§6.4.6、G3）。
 *
 * **AI 看不到图。** 一道带图的题原样把 `![fig1]` 发过去，模型会照着残缺信息
 * 一本正经地编一段解析——不报错，但结果是错的。删掉更糟：连"这里本来有张图"
 * 都不剩了，模型会当成题干就这么点内容。所以换成 `[图：<alt>]`。
 *
 * 公式原样保留：模型认识 LaTeX，`$\frac{a}{b}$` 它读得懂。
 */
export function stemForAi(text, assets) {
  const byKey = new Map((assets || []).map((a) => [a.key ?? a.asset_key, a]));
  return String(text ?? '').replace(ASSET_REF_RE, (whole, key) => {
    const a = byKey.get(key);
    if (!a) {
      // 引用了不存在的资源。发布校验会拦住这种题，真漏到这里说明校验被绕过了，
      // 与其发一段残缺题干给模型，不如当场抛错。
      throw fail('asset_missing', `题干引用了 ![${key}]，但题目没有这个资源`);
    }
    const alt = String(a.alt ?? '').trim();
    if (!alt) throw fail('asset_without_alt', `资源 ${key} 没有 alt，喂给 AI 的题干会缺一块`);
    return `[图：${alt}]`;
  });
}

// alt 只拦得住最偷懒的那一种写法。"图1""fig2""图片"这类等于没写——
// 它替代不了图，AI 拿到 `[图：图1]` 和拿到 `![fig1]` 没有区别。
// 拦不住敷衍的（"一张示意图"），那要靠人看。
const LAZY_ALT_RE = /^(图片?|图\s*\d+|fig(ure)?\s*\d*|image|picture|示意图)$/i;
const ALT_MIN = 5;

/**
 * 题目契约里与资源有关的那几条（§6.4.6、§6.4.9、G2）。**在种子生成阶段调用**，
 * 返回问题清单；空数组表示没问题。
 *
 * @param question {questionId, stem, options?, itemAnswers?}
 * @param assets   [{key, kind, path, alt, caption}]
 * @param opts.fileExists  可选：判断资源文件在不在盘上。种子阶段传进来，
 *                         线上发布校验没有文件系统，不传就跳过这一条。
 */
export function validateAssets(question, assets, opts = {}) {
  const problems = [];
  const where = `题目 ${question.questionId}`;
  const list = Array.isArray(assets) ? assets : [];

  const keys = new Set();
  for (const a of list) {
    const key = String(a.key ?? '');
    if (!/^[A-Za-z0-9_-]+$/.test(key)) {
      problems.push(`${where} 的资源 key ${JSON.stringify(a.key)} 不合法（只能用字母数字下划线连字符）`);
      continue;
    }
    if (keys.has(key)) problems.push(`${where} 的资源 key ${key} 重复`);
    keys.add(key);

    if (!ASSET_KINDS.includes(a.kind)) {
      problems.push(`${where} 的资源 ${key} 类型是 ${JSON.stringify(a.kind)}，只认 ${ASSET_KINDS.join('、')}`);
    }
    const p = String(a.path ?? '');
    // path 会被拼成 URL，所以这里既是数据校验也是一道安全边界
    if (!p || p.startsWith('/') || p.includes('..') || p.includes('\\')) {
      problems.push(`${where} 的资源 ${key} 路径 ${JSON.stringify(a.path)} 不合法（要相对路径，不许有 .. 或反斜杠）`);
    } else if (opts.fileExists && !opts.fileExists(p)) {
      // 路径打错了不会报错，只会在学生面前显示一个破图
      problems.push(`${where} 的资源 ${key} 指向 ${p}，但这个文件不在盘上`);
    }

    if (a.kind === 'IMAGE') {
      const alt = String(a.alt ?? '').trim();
      if (!alt) {
        problems.push(`${where} 的图片 ${key} 没有 alt。alt 不是无障碍客套话：` +
          'AI 看不到图，alt 空着它会照着残缺题干编一段解析');
      } else if (LAZY_ALT_RE.test(alt) || alt.length < ALT_MIN) {
        problems.push(`${where} 的图片 ${key} 的 alt 是 ${JSON.stringify(alt)}，` +
          '它替代不了这张图。要写成"能替代这张图的一句话"');
      }
    }
  }

  // 题干、选项、逐项答案里引用的 key 都必须存在
  const texts = [question.stem, ...(question.options || []), ...(question.itemAnswers || [])];
  const referenced = new Set();
  for (const t of texts) {
    for (const key of assetRefsIn(t)) {
      referenced.add(key);
      if (!keys.has(key)) {
        problems.push(`${where} 引用了 ![${key}]，但题目没有声明这个资源` +
          `（声明了的是 ${[...keys].join('、') || '（没有）'}）`);
      }
    }
  }
  // 声明了却没人引用：这张图不会显示出来，而出题人是打算让它显示的。
  // 多半是题干里那个 key 拼错了——上一条从另一头也会报，两条一起看就知道拼错在哪。
  for (const key of keys) {
    if (!referenced.has(key)) {
      problems.push(`${where} 声明了资源 ${key}，但题干和选项里没有 ![${key}]，它不会显示出来`);
    }
  }
  return problems;
}

/**
 * 一次读多道题的资源，返回 questionId → [{key, kind, path, alt, caption}]。
 *
 * 与 question-items.js 的 loadItemRows 同一个路子：喂 AI 前要逐题做 ![key] 替换，
 * 每题读一次库就是 N 次往返。
 */
export async function loadAssetRows(db, questionIds) {
  const ids = [...new Set((questionIds || []).filter(Boolean))];
  const out = new Map();
  if (!ids.length) return out;
  for (let i = 0; i < ids.length; i += 90) {
    const batch = ids.slice(i, i + 90);
    const { results } = await db.prepare(
      `SELECT question_id, asset_key, kind, path, alt, caption FROM question_assets
        WHERE question_id IN (${batch.map(() => '?').join(',')})
        ORDER BY question_id, asset_key`
    ).bind(...batch).all();
    for (const r of results) {
      if (!out.has(r.question_id)) out.set(r.question_id, []);
      out.get(r.question_id).push({
        key: r.asset_key, kind: r.kind, path: r.path, alt: r.alt, caption: r.caption,
      });
    }
  }
  return out;
}
