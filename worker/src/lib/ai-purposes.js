// AI 配置的用途清单（§6.4.3、N7d）。**合法取值只在这里定义一次。**
//
// 为什么单开一个模块：这份清单原先散在三处——ai_settings 的 CHECK、
// admin-ai.js 的 PURPOSES、ai.js 里写死的回落链。加一档要改三处，漏一处的表现
// 各不相同（库里插不进去 / 接口 400 / 配了但永远取不到），而且都不像同一个原因。
// 现在 JS 侧全从这里取；SQL 那个 CHECK 改不动的部分由 ai-purposes.test.mjs 对齐。
//
// 三档的分工，按**喂给模型的是什么**分，不按学科分：
//   PARSING       图片型原始资料（扫描件、拍照的卷子）→ 要能读图
//   TEXT_PARSING  文字型原始资料（docx、纯文本）→ 不需要读图，可以用便宜得多的模型
//   TUTORING      教学侧（主观题批改、错题解析、学习建议）
//
// 分开 PARSING 与 TEXT_PARSING 的理由很实在：两者合一时，哪怕你只传 docx，
// 也被迫配一个视觉模型——贵、慢，而且纯文字任务上往往还不如同价位的文本模型。

export const AI_PURPOSES = [
  {
    code: 'PARSING',
    label: '图片解析 AI',
    // 回落链的终点，不再往下找
    fallbackTo: null,
    needsVision: true,
    desc: '把图片型原始资料（扫描件、拍照的卷子）转成文字并结构化。必须支持图片输入。',
  },
  {
    code: 'TEXT_PARSING',
    label: '文字解析 AI',
    // 没配就沿用图片解析那档——老装机升上来时不至于突然不能用。
    // 但这是**回落，不是等价**：图片模型跑纯文字通常更贵更慢，界面上要说出来。
    fallbackTo: 'PARSING',
    needsVision: false,
    desc: '处理文字型原始资料（docx、纯文本），并为上传的题生成候选答案与解析。不需要读图。',
  },
  {
    code: 'TUTORING',
    label: '教学 AI',
    // 先找文字解析，再回落到图片解析。教学侧全是文字活，文字模型更合适；
    // 两档都没配时退回原来的行为，升级不会改变既有装机的表现。
    fallbackTo: 'TEXT_PARSING',
    needsVision: false,
    desc: '批改主观题、生成错题解析与学习建议。',
  },
];

export const PURPOSE_CODES = AI_PURPOSES.map((p) => p.code);

export function purposeMeta(code) {
  return AI_PURPOSES.find((p) => p.code === code) || null;
}

export function isPurpose(code) {
  return PURPOSE_CODES.includes(code);
}

/**
 * 某个用途的取值顺序：自己 → 回落目标 → 再回落……
 * 显式展开成一条链而不是递归查，是为了让调用方能说出"实际用的是哪一档"——
 * 静默回落最坏的形态是管理员以为在用自己配的模型，账单却记在另一档上。
 */
export function purposeChain(code) {
  const chain = [];
  let cur = code;
  while (cur && !chain.includes(cur)) {
    chain.push(cur);
    cur = purposeMeta(cur)?.fallbackTo || null;
  }
  return chain;
}

/**
 * 原始资料是图片还是文字，决定用哪一档配置。
 * 管线在 PIPELINES 里自己声明 mediaKind，不在这里按学科硬判——
 * 按学科判的话，同一个学科将来同时有扫描件和 docx 就说不清了。
 */
export function purposeForMedia(mediaKind) {
  return mediaKind === 'image' ? 'PARSING' : 'TEXT_PARSING';
}
