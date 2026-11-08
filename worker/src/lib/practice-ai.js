// 练习里按采分点当场 AI 批改（改进阶段 2 P1-G1，用户 2026-11-07 定：有标准答案的按标准答案判，
// 只有采分点的题才 AI 批；每月花费到上限批改也不停）。
//
// 批改本身走模考那同一个函数（tutor.js 的 gradeScorePoints）和 grade.js 那唯一的判分循环，这里只管四件事：
//   - 这道题该不该当场批（题型按采分点判、学科开着开关）；
//   - 缓存：同一个人、同一道题、一字不差的作答不重复批（不重复花钱）；
//   - 每人每天的次数上限——每月上限不拦批改，这是防刷唯一的一道闸；
//   - 时限：学员在页面上等着，单次 20 秒中止，连 chatJSON 的一次重试在内最多约 40 秒。
import { gradeScorePoints } from './tutor.js';
import { promptFor, settingInt } from './subject-pack.js';
import { beijingDayStartUtc } from './beijing-time.js';

export const PRACTICE_AI_FEATURE = 'practice_point_grade';
export const PRACTICE_AI_TIMEOUT_MS = 20000;

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 这道题在练习里要不要当场 AI 批：题型声明按采分点判，且学科开着 practice_ai_grading。 */
export async function practiceAiEnabled(db, pack, question) {
  if (pack.typeOf(question.question_type).gradingStrategy !== 'AI_SCORE_POINTS') return false;
  const row = await db.prepare('SELECT practice_ai_grading FROM subjects WHERE subject_id = ?')
    .bind(pack.subjectId).first();
  if (!row) throw Object.assign(new Error(`学科#${pack.subjectId} 不存在`), { code: 'subject_not_found' });
  return Number(row.practice_ai_grading) === 1;
}

/**
 * 缓存键的后半段：这道题的采分点 + 批改提示词的正文。后台改了采分点或提示词，旧缓存自然不再命中——
 * 否则学员会拿到按旧采分点批出来的结果。
 */
export async function gradingKey(db, pack, items) {
  const p = await promptFor(db, pack.subjectId, 'essay_grade');
  const pts = items.map((r) => [r.item_ord, r.item_kind, r.answer, r.weight]);
  return sha256Hex(JSON.stringify({ pts, sys: p.systemPrompt, tpl: p.userTemplate }));
}

export async function answerHash(answer) {
  return sha256Hex(answer ?? '');
}

export async function cachedResult(db, { userId, questionId, answerSha, keySha }) {
  const row = await db.prepare(
    `SELECT result_json FROM practice_ai_cache
      WHERE user_id = ? AND question_id = ? AND answer_sha256 = ? AND key_sha256 = ?`
  ).bind(userId, questionId, answerSha, keySha).first();
  if (!row) return null;
  try {
    return JSON.parse(row.result_json);
  } catch {
    return null;   // 坏了的缓存当没有，重新批
  }
}

export function cacheWrite(db, { userId, questionId, answerSha, keySha, aiResult }) {
  return db.prepare(
    `INSERT OR IGNORE INTO practice_ai_cache (user_id, question_id, answer_sha256, key_sha256, result_json)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(userId, questionId, answerSha, keySha, JSON.stringify(aiResult));
}

/**
 * 今天（北京日）这个人已经调了几次练习批改。按用量日志数，**失败的调用也算**：
 * 失败不进缓存，按缓存数的话"再批一次"能无限调 AI（评审指出的漏洞）。
 */
export async function usedToday(db, userId, now = Date.now()) {
  const row = await db.prepare(
    `SELECT COUNT(*) AS n FROM ai_usage_logs
      WHERE user_id = ? AND feature = ? AND created_at >= ?`
  ).bind(userId, PRACTICE_AI_FEATURE, beijingDayStartUtc(now)).first();
  return Number(row?.n || 0);
}

export async function dailyLimit(db, subjectId) {
  return settingInt(db, subjectId, 'limit.practice_ai_per_day');
}

/** 调模型批一道题。返回 aiResult（判分器要的形状）或抛错（code 给页面说人话用）。 */
export async function gradeNow(env, pack, { question, items, assets, answer, userId }) {
  // 时限可由环境变量调短（只给测试用：替身的【超时】要 5 秒，等满 20 秒太慢）。读不懂就用默认值——
  // 这是测试开关，不是业务配置，读不懂不该让学员的批改失败。
  const t = Number(env.PRACTICE_AI_TIMEOUT_MS);
  return gradeScorePoints(env, pack, {
    stem: question.stem, assets, answer, items, where: `题目 ${question.question_id}`,
    feature: PRACTICE_AI_FEATURE, userId, timeoutMs: t > 0 ? t : PRACTICE_AI_TIMEOUT_MS,
  });
}

/** 批改失败时给学员看的话。不显示 0 分，显示采分点让他自己对照，可以再试一次。 */
export function aiErrorMessage(code) {
  switch (code) {
    case 'daily_limit': return '今天的 AI 批改用完了，明天再来；这次先对照采分点自己看看。';
    case 'ai_timeout': return 'AI 这次没在规定时间内批完，先对照采分点自己看看，也可以再让 AI 批一次。';
    case 'ai_not_configured': return 'AI 批改还没配置好，先对照采分点自己看看。';
    default: return 'AI 这次没批出来，先对照采分点自己看看，也可以再让 AI 批一次。';
  }
}
