// 首页用的学习活跃度（2026-11-16 首页改版）：连续学习天数、最近 7 天每天做了几次、按北京时间问候。
// 纯函数，node 里也能测（worker/test/home-activity.test.mjs）。日子一律按北京时间切（和 lib/time.js 同一个口径）。
import { parseDbTime } from './time.js';

const OFFSET_MS = 8 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

/** 毫秒 → 北京时间那一天的序号（自 1970-01-01 起第几天），同一天的两个时刻序号相同 */
export function beijingDayIndex(ms) {
  return Math.floor((ms + OFFSET_MS) / DAY_MS);
}

/** 库里的时间列表 → 有活动的北京日子序号集合（读不懂的时间跳过，不算进任何一天） */
function activeDays(times) {
  const days = new Set();
  for (const t of times || []) {
    const ms = parseDbTime(t);
    if (!Number.isNaN(ms)) days.add(beijingDayIndex(ms));
  }
  return days;
}

/**
 * 连续学习天数：从今天往回数，每天都有活动就加一。今天还没学、昨天学了，连续不断（今天还有机会），从昨天往回数；
 * 昨天也没学就是 0。
 */
export function streakDays(times, nowMs = Date.now()) {
  const days = activeDays(times);
  const today = beijingDayIndex(nowMs);
  let d = days.has(today) ? today : today - 1;
  let n = 0;
  while (days.has(d)) { n++; d--; }
  return n;
}

/** 最近 7 天（含今天），从早到晚：[{ label: '一' | … | '今天', count, today }] */
export function lastSevenDays(times, nowMs = Date.now()) {
  const counts = new Map();
  for (const t of times || []) {
    const ms = parseDbTime(t);
    if (Number.isNaN(ms)) continue;
    const k = beijingDayIndex(ms);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const today = beijingDayIndex(nowMs);
  const out = [];
  for (let k = today - 6; k <= today; k++) {
    // 第 k 天的星期：1970-01-01 是星期四（4）
    const dow = ((k % 7) + 7 + 4) % 7;
    out.push({ label: k === today ? '今天' : WEEK[dow], count: counts.get(k) || 0, today: k === today });
  }
  return out;
}

/** 按北京时间问候 */
export function greeting(nowMs = Date.now()) {
  const h = new Date(nowMs + OFFSET_MS).getUTCHours();
  if (h >= 5 && h < 11) return '早上好';
  if (h >= 11 && h < 13) return '中午好';
  if (h >= 13 && h < 18) return '下午好';
  return '晚上好';
}
