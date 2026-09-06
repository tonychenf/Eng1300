-- M5：错题本与能力评估。对应 docs/prd.md §5.7、§5.8、§8。
--
-- 错题记录在交卷/答题时就写好（不依赖 AI），AI 只负责事后补上
-- error_analysis 与 memory_point 两个字段。这样 AI 不可用时错题本照常能用。

CREATE TABLE IF NOT EXISTS wrong_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  course_code TEXT NOT NULL,
  question_id TEXT NOT NULL REFERENCES questions(question_id),
  last_attempt_id TEXT REFERENCES attempts(attempt_id),
  source TEXT NOT NULL DEFAULT 'EXAM',      -- 最近一次错在模考还是练习
  wrong_count INTEGER NOT NULL DEFAULT 1,
  streak_correct INTEGER NOT NULL DEFAULT 0, -- 后续连续答对次数，满 2 次自动订正
  error_analysis TEXT,                       -- AI 给的错因
  memory_point TEXT,                         -- AI 给的记忆要点
  ai_status TEXT NOT NULL DEFAULT '待生成'
    CHECK (ai_status IN ('待生成', '已生成', '待重试')),
  corrected INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 同一题多次做错只留一条，累计次数（PRD §5.7）
CREATE UNIQUE INDEX IF NOT EXISTS idx_wrong_unique ON wrong_items(user_id, question_id);
CREATE INDEX IF NOT EXISTS idx_wrong_user ON wrong_items(user_id, course_code, corrected);

CREATE TABLE IF NOT EXISTS assessments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  course_code TEXT NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  stat_predicted_score REAL,
  stat_low REAL,
  stat_high REAL,
  ai_level_desc TEXT,
  ai_predicted_low REAL,
  ai_predicted_high REAL,
  weak_points TEXT,     -- JSON
  suggestions TEXT,     -- JSON
  ai_status TEXT NOT NULL DEFAULT '待生成'
    CHECK (ai_status IN ('待生成', '已生成', '待重试'))
);
CREATE INDEX IF NOT EXISTS idx_assess_user ON assessments(user_id, course_code, generated_at DESC);
