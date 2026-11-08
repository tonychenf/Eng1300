-- 改进阶段 2 第一期（2026-11-08）：后台自助开学科。需求见 docs/改进阶段2-PRD.md。
--
-- 只建新表、写默认参数、给评价标准补一项。给已有表加的列（subjects 两个开关、courses.template_version、
-- ai_settings 单价、ai_usage_logs 记账、attempts.section_meta）不在这里：旧库由 scripts/ci/ensure-columns.sh
-- 在迁移之前补，新库从 0002 / 0005 的建表语句就带着。**这个文件里任何一句都不许提到那些新列**——
-- SQLite 准备语句时就校验列名，旧库上整条迁移会失败（部署 #48 那次）。

-- ① 后台操作审计：建学科、改课程、改模板、一键发布、一键开通、改花费上限……
--    写审计失败不拦主操作（记账类），所以这张表没有外键，删了学科审计也留着。
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER,
  action TEXT NOT NULL,
  subject_id INTEGER,
  target TEXT,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit(created_at);

-- ② 练习里按采分点 AI 批改的结果缓存。同一个人、同一道题、一字不差的作答不重复批（不重复花钱）。
--    key_sha256 = 这道题的采分点 + 批改提示词正文的指纹：后台改了采分点或提示词，旧缓存自然不再命中。
--    今日次数不按这张表数（失败的调用不进缓存），按 ai_usage_logs 数。
CREATE TABLE IF NOT EXISTS practice_ai_cache (
  user_id INTEGER NOT NULL,
  question_id TEXT NOT NULL,
  answer_sha256 TEXT NOT NULL,
  key_sha256 TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, question_id, answer_sha256, key_sha256)
);

-- ③ 每个北京月的 AI 花费累计。每次调用记账时顺手累加；查"到没到上限"只读这一行，
--    不每次 SUM 一遍当月日志（吃读取额度）。
CREATE TABLE IF NOT EXISTS ai_spend_monthly (
  month TEXT PRIMARY KEY,                 -- 北京月 yyyy-mm
  cost_yuan REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  calls_without_price INTEGER NOT NULL DEFAULT 0
);

-- 今日次数要按 用户 + 功能 + 时间 查 ai_usage_logs
CREATE INDEX IF NOT EXISTS idx_usage_feature_created ON ai_usage_logs(feature, created_at);

-- ④ 参数：每个学员每天最多几道练习 AI 批改（防刷的唯一一道闸：每月上限不拦批改，用户 2026-11-07 定的）。
--    门闩：管理员改过的值不被冲回去，删过的不被插回来。
INSERT OR IGNORE INTO system_settings (key, value, description)
SELECT 'limit.practice_ai_per_day', '100', '每个学员每天最多几道练习题让 AI 批改（失败的调用也算）'
 WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'phase2-settings');
INSERT OR IGNORE INTO seed_state (name, sha)
SELECT 'phase2-settings', 'v1'
 WHERE EXISTS (SELECT 1 FROM system_settings WHERE key = 'limit.practice_ai_per_day');

-- ⑤ 评价标准补一项 mastery.pointCorrectThreshold：按采分点判的题，得分率到多少算"答对"（只决定掌握度和错题本）。
--    用户定 0.6（2026-11-07）：翻译很少每个采分点都对上，沿用 correctThreshold = 1.0 几乎每道都进错题本。
--    只补当前生效的那一版、只补还没有这一项的；门闩管住"管理员后来删掉这一项"的情况。
UPDATE subject_rubrics
   SET payload = json_set(payload, '$.mastery.pointCorrectThreshold', 0.6)
 WHERE is_current = 1
   AND json_extract(payload, '$.mastery.pointCorrectThreshold') IS NULL
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'phase2-point-threshold');
INSERT OR IGNORE INTO seed_state (name, sha)
SELECT 'phase2-point-threshold', 'v1'
 WHERE NOT EXISTS (SELECT 1 FROM subject_rubrics
                    WHERE is_current = 1 AND json_extract(payload, '$.mastery.pointCorrectThreshold') IS NULL);
