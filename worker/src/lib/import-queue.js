// AI 拆题导入的后台排队（改进阶段 2 第三期，PRD P3-C2 / P3-C5）。cron 每分钟叫醒一次 processImportTick。
//
// 一次醒来做两件事：
//   ① 认领几页「待识别」的页（起始 4 页、并发 2），从 KV 取图、读图模型识别；当场能查的几条（乱码、几乎没认出字、
//      比别的页少很多）命中了，趁图还在用另一个提示词再识别一遍、留下两次不一致的地方；然后**立刻删图**（P3-C5）；
//   ② 一个任务的页全有了结果，就拆题（import-split.js），进「待核对」。
//
// 认领一律是带条件的 UPDATE（状态还是原来那个才改），两次醒来撞在一起（上一次拆题拖过了一分钟）也不会重复识别、重复拆题。
// 卡在「识别中」超过 10 分钟的页（上一次醒来中途被杀了）放回「待识别」。
import { chat, costOf, mapLimit, resolveSettings } from './ai.js';
import { pageQuickIssues, altDiffs } from './import-checks.js';
import { splitPages, assignIds } from './import-split.js';

export const IMPORT_LIMITS = {
  maxPages: 50,          // 一次导入最多 50 页（用户 2026-11-10 定）
  perTick: 4,            // 每次醒来最多识别几页（免费计划一次最多 50 个子请求，读图一页十几到几十秒）
  concurrency: 2,
  maxAttempts: 3,        // 单页失败重试 2 次
  imageTtl: 86400,       // KV 里的图 1 天自动过期兜底
  maxImageBytes: 4 * 1024 * 1024,
  ocrTimeoutMs: 90000,
};

export const IMPORT_OCR_PROMPT = [
  '请把这张图片里的文字完整、逐字识别出来，按原来的换行输出纯文本。',
  '- 第一行单独写书上印的页码，格式是「【页码】123」；看不到页码就写「【页码】无」。',
  '- 题号、选项字母照原样写出；手写的答案、批注也照原样写出来，写在它旁边的位置。',
  '- 表格按行写，同一行的格子之间用空格隔开；公式照原样写（可以用 LaTeX）。',
  '- 看不清的字写 □，不要猜，不要补全，也不要改正原文里的错；',
  '- 不要加任何解释，不要用 Markdown。',
].join('\n');

// 第二遍：换一种说法，让模型换一条路读（两次一致的地方大概率是对的，不一致的地方给人看）
export const IMPORT_OCR_PROMPT_ALT = [
  '这是一页书的照片。请一行一行地抄下图片上的全部文字，保持原来的分行。',
  '- 第一行写「【页码】」加书上印的页码，没有页码写「【页码】无」。',
  '- 每个字都按图片上的样子抄，拿不准的字写 □；不要解释、不要总结、不要用 Markdown。',
].join('\n');

/** 从识别结果里取出第一行的【页码】，正文去掉那一行。 */
export function takePrintedPage(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const i = lines.findIndex((l) => l.trim());
  const m = i >= 0 ? lines[i].match(/^\s*【\s*页码\s*】\s*(\d{1,4}|无)?/) : null;
  if (!m) return { printedPage: null, body: lines.join('\n').trim() };
  lines.splice(i, 1);
  return { printedPage: m[1] && m[1] !== '无' ? Number(m[1]) : null, body: lines.join('\n').trim() };
}

export const imageKey = (jobId, pageNo, stamp) => `import/${jobId}/${pageNo}/${stamp}`;

async function ocrOnce(env, settings, image, prompt, subjectId) {
  const r = await chat(env, {
    purpose: 'PARSING', feature: 'import_ocr', settings, subjectId, maxTokens: 4000, timeoutMs: IMPORT_LIMITS.ocrTimeoutMs,
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: prompt }] }],
  });
  return { ...takePrintedPage(r.content), cost: costOf(settings, r.usage) };
}

async function recognizePage(env, page, settings, minChars) {
  const db = env.DB;
  const image = page.image_key ? await env.IMPORT_IMAGES.get(page.image_key) : null;
  if (!image) {
    // 图没了（过期、被放弃时删了）：这一页没法再识别，等重拍
    await db.prepare(
      `UPDATE import_pages SET status = '失败', error = ?, image_key = NULL, updated_at = datetime('now')
        WHERE job_id = ? AND page_no = ?`
    ).bind('照片已经不在了（超过一天没识别，或者任务放弃过），请重拍这一页', page.job_id, page.page_no).run();
    return;
  }
  let first;
  try {
    first = await ocrOnce(env, settings, image, IMPORT_OCR_PROMPT, page.subject_id);
  } catch (e) {
    const attempts = Number(page.attempts || 0) + 1;
    const giveUp = attempts >= IMPORT_LIMITS.maxAttempts;
    const msg = `${e.code || 'ai_failed'}${e.detail ? `：${JSON.stringify(e.detail).slice(0, 160)}` : ''}`;
    if (giveUp) await env.IMPORT_IMAGES.delete(page.image_key);
    await db.prepare(
      `UPDATE import_pages SET status = ?, attempts = ?, error = ?, image_key = CASE WHEN ? THEN NULL ELSE image_key END,
              updated_at = datetime('now') WHERE job_id = ? AND page_no = ?`
    ).bind(giveUp ? '失败' : '待识别', attempts, msg, giveUp ? 1 : 0, page.job_id, page.page_no).run();
    return;
  }
  let cost = first.cost ?? 0;
  const quick = pageQuickIssues(first.body, { minChars });
  let alt = null;
  let diffs = [];
  if (quick.length) {
    // 图还在，换个说法再读一遍；第二遍失败不影响第一遍的结果
    try {
      alt = await ocrOnce(env, settings, image, IMPORT_OCR_PROMPT_ALT, page.subject_id);
      cost += alt.cost ?? 0;
      diffs = altDiffs(first.body, alt.body);
    } catch { alt = null; }
  }
  // 识别完（含第二遍）立刻删图，不等核对、不等入库（P3-C5）
  await env.IMPORT_IMAGES.delete(page.image_key);
  await db.batch([
    db.prepare(
      `UPDATE import_pages SET status = '已识别', text = ?, text_alt = ?, printed_page = ?, issues_json = ?, image_key = NULL,
              attempts = attempts + 1, cost_yuan = cost_yuan + ?, error = NULL, updated_at = datetime('now')
        WHERE job_id = ? AND page_no = ?`
    ).bind(first.body, alt ? alt.body : null, first.printedPage ?? alt?.printedPage ?? null,
      JSON.stringify({ quick, altDiffs: diffs }), cost, page.job_id, page.page_no),
    db.prepare(`UPDATE import_jobs SET cost_yuan = cost_yuan + ?, updated_at = datetime('now') WHERE job_id = ?`)
      .bind(cost, page.job_id),
  ]);
}

/** 本学科的题型声明（拆题提示、体检、入库都要）。 */
export async function subjectTypes(db, subjectId) {
  const { results } = await db.prepare(
    `SELECT type_code, name, input_widget, grading_strategy FROM subject_question_types
      WHERE subject_id = ? ORDER BY sort_order, type_code`
  ).bind(subjectId).all();
  return results.map((t) => ({ code: t.type_code, name: t.name, widget: t.input_widget, strategy: t.grading_strategy }));
}

async function sectionTypesOf(db, subjectId) {
  const { results } = await db.prepare(
    `SELECT DISTINCT s.type FROM sections s JOIN exams e ON e.exam_id = s.exam_id
       JOIN courses co ON co.course_code = e.course_code WHERE co.subject_id = ? ORDER BY s.type LIMIT 30`
  ).bind(subjectId).all();
  return results.map((r) => r.type).filter(Boolean);
}

/** 拆题：整份（第一次）或只拆重拍过的几页（换掉草稿里这几页的题）。 */
export async function runSplit(env, job) {
  const db = env.DB;
  const fail = (message) => db.prepare(
    `UPDATE import_jobs SET status = '失败', error = ?, updated_at = datetime('now') WHERE job_id = ? AND status = '拆题中'`
  ).bind(message, job.job_id).run();
  const subject = await db.prepare('SELECT subject_id, name FROM subjects WHERE subject_id = ?').bind(job.subject_id).first();
  const settings = await resolveSettings(env, 'TEXT_PARSING');
  if (!settings) return fail('「文字解析 AI」和「图片解析 AI」都没配，拆不了题。到 AI 配置页配好后点「重新拆题」');
  const { results: pageRows } = await db.prepare(
    'SELECT page_no, printed_page, text, status FROM import_pages WHERE job_id = ? ORDER BY page_no'
  ).bind(job.job_id).all();
  const draft = job.draft_json ? JSON.parse(job.draft_json) : null;
  const only = draft?.resplitPages?.length ? new Set(draft.resplitPages.map(Number)) : null;
  const usable = pageRows.filter((p) => p.status === '已识别' && (!only || only.has(p.page_no)))
    .map((p) => ({ pageNo: p.page_no, printedPage: p.printed_page, text: p.text }));
  if (!usable.length && !only) return fail('一页都没有识别出来，拆不了题。请检查「图片解析 AI」的配置，或重拍后重试');

  const types = await subjectTypes(db, job.subject_id);
  let result = { sections: [], cost: 0 };
  if (usable.length) {
    try {
      result = await splitPages(env, {
        subjectId: job.subject_id, subjectName: subject?.name || '', types,
        sectionTypes: await sectionTypesOf(db, job.subject_id), pages: usable, settings,
      });
    } catch (e) {
      return fail(`${e.message || e}。识别出的文字都留着，点「重新拆题」再试`);
    }
  }
  let next;
  if (!only) {
    assignIds(result.sections);
    next = { sections: result.sections, resolved: [], edited: {}, nextId: result.sections.reduce((n, s) => n + s.questions.length, 0) + 1 };
  } else {
    // 重拍：去掉这几页原来的题，新拆出来的题按大题类别 + 标题放回原来那一部分（没有就加在最后）
    next = { ...draft, resplitPages: [] };
    let n = draft.nextId || 1;
    for (const s of next.sections) s.questions = s.questions.filter((q) => !only.has(q.pageNo));
    for (const ns of result.sections) {
      for (const q of ns.questions) q.id = `q${n++}`;
      const hit = next.sections.find((s) => s.type === ns.type && (s.title || '') === (ns.title || ''));
      if (hit) {
        hit.questions.push(...ns.questions);
        hit.questions.sort((a, b) => a.pageNo - b.pageNo || (a.no ?? 0) - (b.no ?? 0));
        if (ns.passage && !hit.passage) hit.passage = ns.passage;
      } else next.sections.push(ns);
    }
    next.sections = next.sections.filter((s) => s.questions.length);
    next.nextId = n;
  }
  await db.prepare(
    `UPDATE import_jobs SET status = '待核对', draft_json = ?, error = NULL, cost_yuan = cost_yuan + ?, updated_at = datetime('now')
      WHERE job_id = ? AND status = '拆题中'`
  ).bind(JSON.stringify(next), result.cost || 0, job.job_id).run();
}

/** cron 每分钟一次。返回这次做了什么（测试、日志用）。 */
export async function processImportTick(env, opts = {}) {
  const db = env.DB;
  const perTick = opts.perTick ?? IMPORT_LIMITS.perTick;
  const done = { recognized: 0, split: [] };
  if (!env.IMPORT_IMAGES) return done;

  // 上一次醒来中途被杀、卡在「识别中」的页放回去
  await db.prepare(
    `UPDATE import_pages SET status = '待识别' WHERE status = '识别中' AND updated_at < datetime('now', '-10 minutes')`
  ).run();

  const { results: queued } = await db.prepare(
    `SELECT p.job_id, p.page_no, p.image_key, p.attempts, j.subject_id
       FROM import_pages p JOIN import_jobs j ON j.job_id = p.job_id
      WHERE p.status = '待识别' AND j.status IN ('待识别', '识别中')
      ORDER BY j.created_at, p.page_no LIMIT ?`
  ).bind(perTick).all();
  const claimed = [];
  for (const p of queued) {
    const r = await db.prepare(
      `UPDATE import_pages SET status = '识别中', updated_at = datetime('now') WHERE job_id = ? AND page_no = ? AND status = '待识别'`
    ).bind(p.job_id, p.page_no).run();
    if (r.meta.changes) claimed.push(p);
  }
  if (claimed.length) {
    for (const jobId of new Set(claimed.map((p) => p.job_id))) {
      await db.prepare(`UPDATE import_jobs SET status = '识别中', updated_at = datetime('now') WHERE job_id = ? AND status = '待识别'`)
        .bind(jobId).run();
    }
    const settings = await resolveSettings(env, 'PARSING');
    if (!settings) {
      for (const p of claimed) {
        await db.prepare(`UPDATE import_pages SET status = '待识别', error = ? WHERE job_id = ? AND page_no = ?`)
          .bind('「图片解析 AI」还没配，配好后会接着识别', p.job_id, p.page_no).run();
      }
    } else {
      // "字数偏少"的线：同一任务已识别各页字数中位数的一半（3 页以上才判）
      const minCharsOf = new Map();
      for (const jobId of new Set(claimed.map((p) => p.job_id))) {
        const { results } = await db.prepare(`SELECT length(text) AS n FROM import_pages WHERE job_id = ? AND status = '已识别'`).bind(jobId).all();
        const xs = results.map((r) => Number(r.n || 0)).filter((n) => n > 0).sort((a, b) => a - b);
        minCharsOf.set(jobId, xs.length >= 3 ? Math.floor(xs[Math.floor(xs.length / 2)] / 2) : 0);
      }
      await mapLimit(claimed, IMPORT_LIMITS.concurrency, (p) => recognizePage(env, p, settings, minCharsOf.get(p.job_id)));
      done.recognized = claimed.length;
    }
  }

  // 页全有结果的任务：拆题。一次醒来只拆一个（拆题要几十秒）
  const { results: ready } = await db.prepare(
    `SELECT j.* FROM import_jobs j
      WHERE j.status = '识别中'
        AND NOT EXISTS (SELECT 1 FROM import_pages p WHERE p.job_id = j.job_id AND p.status IN ('待识别', '识别中'))
      ORDER BY j.created_at LIMIT 1`
  ).all();
  for (const job of ready) {
    const r = await db.prepare(
      `UPDATE import_jobs SET status = '拆题中', updated_at = datetime('now') WHERE job_id = ? AND status = '识别中'`
    ).bind(job.job_id).run();
    if (!r.meta.changes) continue;
    await runSplit(env, job);
    done.split.push(job.job_id);
  }
  return done;
}
