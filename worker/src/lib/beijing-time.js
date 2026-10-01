// 北京时间与库里的世界时（CR-M7）。
//
// 库里的时间一律是世界时（SQLite 的 datetime('now')，和它比较的也都得是世界时），只在显示时换成
// 北京时间（前端 web/src/lib/time.js）。这里是后端自己要做的两件事：管理员选的到期日怎么存，
// 给学员看的到期提示怎么写。

/**
 * 管理员选的到期日（北京时间的某一天）→ 库里存的世界时。
 * 「10 月 1 日到期」= 北京时间 10 月 1 日 23:59:59 之后失效 = 世界时同一天 15:59:59。
 * 以前前端发 "YYYY-MM-DD 23:59:59"、后端原样存，被当成世界时比较，实际要到第二天早上 8 点才失效。
 * 认 "YYYY-MM-DD"，也认旧页面发来的 "YYYY-MM-DD 23:59:59"（浏览器里可能还缓存着旧前端）；空 = 长期。
 * 别的一律抛错（code: invalid_expires_at）——以前什么字符串都原样存进去，再拿去和时间比大小。
 */
export function expiryToUtc(input) {
  if (input == null || input === '') return null;
  const m = String(input).trim().match(/^(\d{4})-(\d{2})-(\d{2})(?: 23:59:59)?$/);
  const real = m && (() => {
    const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    return d.getUTCFullYear() === +m[1] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3];
  })();
  if (!real) {
    const err = new Error(`到期日要写成 YYYY-MM-DD（北京时间的哪一天），收到的是「${String(input).slice(0, 40)}」`);
    err.code = 'invalid_expires_at';
    throw err;
  }
  return `${m[1]}-${m[2]}-${m[3]} 15:59:59`;
}

/** 库里的世界时 "YYYY-MM-DD HH:MM:SS" → 北京时间 "YYYY-MM-DD HH:MM"，给提示文案用。读不懂原样返回。 */
export function utcToBeijing(ts) {
  const m = String(ts ?? '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return String(ts ?? '');
  const ms = Date.parse(`${m[1]}T${m[2]}Z`);
  if (Number.isNaN(ms)) return String(ts);
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ');
}
