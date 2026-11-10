// AI 拆题（改进阶段 2 第三期，PRD P3-C2）：把识别出来的整份文字拆成大题和题目。
//
// 文字按页序拼起来、几页一段交给文本模型（「文字解析 AI」那一档，没配就回落到「图片解析 AI」），
// 一段一次调用。模型只能填固定的几个字段；形状校验不过整段重试一次，再不过整份记"拆题失败"、保留文字，
// 管理员可以点重试——**不拿半份拆题结果去核对**：缺了的那几页在核对页上看起来就像"这几页没有题"。
//
// 跨段的大题：后一段的第一部分如果是接着前一段最后一部分往下写的（同一篇阅读、同一组选择题），
// 模型在那一部分上标 continues: true，这里把它并回去。
import { chatJSON, costOf, mapLimit } from './ai.js';

export const SPLIT_PAGES_PER_CALL = 4;
export const SPLIT_CHARS_PER_CALL = 9000;
export const SPLIT_CONCURRENCY = 3;

function bad(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 按页分段：每段不超过 4 页、不超过 9000 字（一页太长就单独一段）。 */
export function chunkPages(pages) {
  const out = [];
  let cur = [];
  let chars = 0;
  for (const p of pages) {
    const n = String(p.text || '').length;
    if (cur.length && (cur.length >= SPLIT_PAGES_PER_CALL || chars + n > SPLIT_CHARS_PER_CALL)) {
      out.push(cur);
      cur = [];
      chars = 0;
    }
    cur.push(p);
    chars += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

export function splitPrompt({ subjectName, types, sectionTypes, chunk, prev }) {
  const typeList = types.map((t) => `${t.code}（${t.name}${t.widget === 'choice' ? '，有 A–D 选项' : ''}）`).join('；');
  const pagesText = chunk.map((p) => `【第 ${p.pageNo} 张照片${Number.isInteger(p.printedPage) ? `，书上第 ${p.printedPage} 页` : ''}】\n${p.text}`).join('\n\n');
  return [
    `下面是「${subjectName}」资料几页照片识别出来的文字，请拆成大题和题目，只输出 JSON。`,
    `本学科的题型（questionType 只能从这里选，写编号）：${typeList}。`,
    sectionTypes.length ? `大题类别（type 尽量用这些名字之一）：${sectionTypes.join('、')}。` : '',
    prev ? `上一段最后一部分是「${prev.title || prev.type}」（最后一题题号 ${prev.lastNo ?? '无'}）。如果这一段开头是接着它往下写的，第一部分写 "continues": true。` : '',
    '规则：',
    '- 题干、选项照原文抄，不要改字、不要补全、不要翻译；看不清的保留原样。',
    '- 选择题的 options 写成 ["A. …","B. …","C. …","D. …"]；不是选择题 options 写 null。',
    '- 阅读、段落填空的原文写进 passage；书上写了本部分题数（如"(1×25)"）就写进 printedCount，没写就 null。',
    '- 题目旁边有手写的答案就写进 handwrittenAnswer，没有写 null。',
    '- pageNo 写这道题出自第几张照片（就是上面【第 N 张照片】的 N）。',
    '- 拿不准的地方写进 doubt，一句话说清楚；没有就 null。',
    '- 页眉、页脚、说明文字不是题，不要拆成题。',
    '只输出这个形状：{"sections":[{"type":"…","title":"…","passage":null,"printedCount":null,"continues":false,' +
      '"questions":[{"no":1,"questionType":"…","stem":"…","options":null,"handwrittenAnswer":null,"pageNo":1,"doubt":null}]}]}',
    '',
    pagesText,
  ].filter(Boolean).join('\n');
}

/** 校验模型回来的形状。题型不认识、页号不在这一段、字段类型不对都算不合格（抛错、整段重试）。 */
export function validateSplit(data, { typeCodes, pageNos }) {
  if (!data || !Array.isArray(data.sections)) {
    throw bad('split_bad_shape', `拆题结果没有 sections 数组（顶层键：${Object.keys(data || {}).join(',') || '空'}）`);
  }
  const out = [];
  for (const [si, s] of data.sections.entries()) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.questions)) throw bad('split_bad_shape', `第 ${si + 1} 部分没有 questions 数组`);
    const qs = [];
    for (const [qi, q] of s.questions.entries()) {
      const where = `第 ${si + 1} 部分第 ${qi + 1} 题`;
      if (!q || typeof q !== 'object') throw bad('split_bad_shape', `${where}不是对象`);
      if (!typeCodes.includes(q.questionType)) throw bad('split_bad_type', `${where}的题型 ${JSON.stringify(q.questionType)} 不在本学科的题型里`);
      if (q.options != null && (!Array.isArray(q.options) || q.options.some((o) => typeof o !== 'string'))) {
        throw bad('split_bad_shape', `${where}的 options 不是字符串数组`);
      }
      const pageNo = Number(q.pageNo);
      if (!pageNos.includes(pageNo)) throw bad('split_bad_page', `${where}的 pageNo=${JSON.stringify(q.pageNo)} 不在这一段（${pageNos.join('、')}）`);
      qs.push({
        no: Number.isInteger(Number(q.no)) && q.no !== null && q.no !== '' ? Number(q.no) : null,
        questionType: q.questionType,
        stem: typeof q.stem === 'string' ? q.stem : '',
        options: q.options && q.options.length ? q.options : null,
        handwrittenAnswer: typeof q.handwrittenAnswer === 'string' && q.handwrittenAnswer.trim() ? q.handwrittenAnswer.trim() : null,
        pageNo,
        doubt: typeof q.doubt === 'string' && q.doubt.trim() ? q.doubt.trim() : null,
      });
    }
    out.push({
      type: String(s.type || '').trim() || '未分类',
      title: typeof s.title === 'string' ? s.title.trim() : '',
      passage: typeof s.passage === 'string' && s.passage.trim() ? s.passage : null,
      printedCount: Number.isInteger(Number(s.printedCount)) && s.printedCount !== null && s.printedCount !== '' ? Number(s.printedCount) : null,
      continues: s.continues === true,
      questions: qs,
    });
  }
  return out;
}

/** 各段拼起来：标了 continues 的接到上一段最后一部分后面（题和原文都接上）。 */
export function mergeChunks(chunkSections) {
  const out = [];
  for (const secs of chunkSections) {
    for (const [i, s] of secs.entries()) {
      const last = out[out.length - 1];
      if (i === 0 && s.continues && last) {
        last.questions.push(...s.questions);
        if (s.passage) last.passage = last.passage ? `${last.passage}\n${s.passage}` : s.passage;
        if (!last.printedCount && s.printedCount) last.printedCount = s.printedCount;
        continue;
      }
      const { continues, ...rest } = s;
      out.push({ ...rest, questions: [...s.questions] });
    }
  }
  return out;
}

/** 给每道题一个草稿里的编号（核对时改题、点"没问题"都按它找）。 */
export function assignIds(sections, start = 1) {
  let n = start;
  for (const s of sections) for (const q of s.questions) q.id = q.id || `q${n++}`;
  return n;
}

/**
 * 拆一份（或几页）文字。
 * @returns { sections, cost, calls }
 */
export async function splitPages(env, { subjectId, subjectName, types, sectionTypes, pages, settings, prevSection = null }) {
  const chunks = chunkPages(pages);
  const typeCodes = types.map((t) => t.code);
  let cost = 0;
  let calls = 0;
  // 段与段之间有先后（后一段要知道前一段最后一部分是什么），但"知道"只是给模型一个提示，
  // 不等前一段拆完：提示里给的是前一段最后一页的页号，续写由合并那一步按 continues 处理。
  const results = await mapLimit(chunks, SPLIT_CONCURRENCY, async (chunk, ci) => {
    const pageNos = chunk.map((p) => p.pageNo);
    const prev = ci === 0 ? prevSection : { title: '', type: `第 ${chunks[ci - 1].at(-1).pageNo} 张照片的最后一部分`, lastNo: null };
    const prompt = splitPrompt({ subjectName, types, sectionTypes, chunk, prev });
    let lastErr = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      calls++;
      try {
        const r = await chatJSON(env, {
          purpose: 'TEXT_PARSING', feature: 'import_split', subjectId, settings, maxTokens: 8000, timeoutMs: 120000,
          messages: [{ role: 'user', content: prompt }],
        });
        const c1 = costOf(settings, r.usage);
        if (c1 != null) cost += c1;
        return validateSplit(r.data, { typeCodes, pageNos });
      } catch (e) {
        lastErr = e;
      }
    }
    throw bad(lastErr?.code === 'split_bad_type' || lastErr?.code?.startsWith?.('split_') ? lastErr.code : 'split_failed',
      `第 ${pageNos.join('、')} 张照片拆题失败：${lastErr?.message || lastErr}`);
  });
  const sections = mergeChunks(results);
  return { sections, cost, calls };
}
