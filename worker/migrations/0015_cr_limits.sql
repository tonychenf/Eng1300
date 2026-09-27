-- CR-M1：组卷限流的两个阈值（worker/src/lib/rate-limit.js 读）。
--
-- 做成系统参数而不是写死在代码里：后台「系统参数」能改，测试也能把它调小来测。
-- INSERT OR IGNORE：每次部署都重跑迁移，管理员改过的值不会被冲回默认值；
-- 这里不删任何数据，所以不需要门闩。
INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
  ('limit.exam_per_minute', '3', '每个学员每分钟最多组几份模拟卷（防止刷掉数据库每日写入额度）'),
  ('limit.exam_per_day', '30', '每个学员 24 小时内最多组几份模拟卷');
