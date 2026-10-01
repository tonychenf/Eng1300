-- CR-M7：授权到期日按北京时间那一天结束。
--
-- 以前前端发 "YYYY-MM-DD 23:59:59"、后端原样存，和 datetime('now')（世界时）比较——选"10 月 1 日到期"，
-- 实际要到北京时间 10 月 2 日早上 8 点才失效。现在后端统一存那一天北京时间 23:59:59 对应的世界时，
-- 也就是同一天的 15:59:59（worker/src/lib/beijing-time.js）。这里把以前存下的换算一次。
--
-- 只换 "日期 23:59:59" 这种形状的：那是旧页面唯一会写出来的样子；手工写进库的别的时刻不猜它的意思。
-- 只能跑一次：流水线每次部署都把 migrations/*.sql 全部重跑，不加门闩的话，哪天有人在库里手工写了一个
-- 23:59:59 的世界时，下一次部署就把它悄悄提前 8 小时。门闩和换算同属一次 d1 execute --file。
UPDATE user_subject_grants
   SET expires_at = datetime(expires_at, '-8 hours')
 WHERE expires_at LIKE '____-__-__ 23:59:59'
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'm7-grant-expiry-beijing');

INSERT OR IGNORE INTO seed_state (name, sha) VALUES ('m7-grant-expiry-beijing', 'done');
