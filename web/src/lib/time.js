// 时间一律按北京时间显示（CR-M7）。
//
// 库里存的是世界时：SQLite 的 datetime('now') 写出 "2026-10-01 07:00:00"，不带时区。页面以前原样显示，
// 北京时间下午 3 点开始的考试显示成早上 7 点。**显示时间的地方都走这里**，不要自己 slice、自己拼——
// worker/test/beijing-time.test.mjs 会扫一遍页面，看见直接显示 xxx_at 的就红。
//
// 不用 Intl 的 timeZone：中国 1991 年以后没有夏令时，固定加 8 小时是精确的；手算在浏览器和 node 单测里
// 结果一样，不依赖运行环境带没带完整的时区数据。

const OFFSET_MS = 8 * 3600 * 1000;

/** 把库里的时间读成毫秒。认 "YYYY-MM-DD HH:MM[:SS[.fff]]"（世界时，不带时区）和带 Z / 偏移的 ISO。读不懂是 NaN。 */
export function parseDbTime(value) {
  if (value == null || value === '') return NaN;
  const s = String(value).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
  if (m) return Date.parse(`${m[1]}T${m[2]}Z`);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(s)) return Date.parse(s);
  return NaN;
}

const pad = (n) => String(n).padStart(2, '0');
function beijingParts(ms) {
  const d = new Date(ms + OFFSET_MS);   // 加 8 小时后按世界时读各个字段，就是北京时间
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    time: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
  };
}

/**
 * 库里的时间 → 北京时间 "YYYY-MM-DD HH:MM"。
 * 空值给 fallback；读不懂的原样返回——显示出来让人看见，不吞掉，也不让整页崩掉。
 */
export function formatBeijing(value, fallback = '—') {
  if (value == null || value === '') return fallback;
  const ms = parseDbTime(value);
  if (Number.isNaN(ms)) return String(value);
  const { date, time } = beijingParts(ms);
  return `${date} ${time}`;
}

/** 只要北京时间的日期 "YYYY-MM-DD"：授权到期日的显示、日期选择框的初值。空值给 fallback，读不懂原样返回。 */
export function beijingDate(value, fallback = '') {
  if (value == null || value === '') return fallback;
  const ms = parseDbTime(value);
  if (Number.isNaN(ms)) return String(value);
  return beijingParts(ms).date;
}
