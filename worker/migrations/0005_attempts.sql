-- M3：模考作答。对应 docs/prd.md §8 的 attempts / answer_records，
-- 外加掌握度表——判分时顺手累计，M4 的自适应出题直接用。

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  course_code TEXT NOT NULL REFERENCES courses(course_code),
  mode TEXT NOT NULL CHECK (mode IN ('EXAM', 'PRACTICE')),
  status TEXT NOT NULL DEFAULT '进行中' CHECK (status IN ('进行中', '已交卷', '已结束')),
  difficulty TEXT NOT NULL DEFAULT '随机' CHECK (difficulty IN ('随机', '简单', '正常', '困难')),
  practice_stage TEXT,
  scope_section_types TEXT,      -- JSON 数组
  scope_knowledge_point TEXT,
  time_limit_minutes INTEGER NOT NULL DEFAULT 150,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  submitted_at TEXT,
  duration_seconds INTEGER,
  total_score REAL,
  objective_score REAL,          -- 客观题得分，交卷即出，不依赖 AI
  section_scores TEXT,           -- JSON
  pending_ai INTEGER NOT NULL DEFAULT 0  -- 还有多少题等着 AI 批改
);
CREATE INDEX IF NOT EXISTS idx_attempts_user ON attempts(user_id, course_code, started_at DESC);

-- 一次作答用到的题目与顺序。组卷结果必须落库：
-- 断线恢复、成绩报告、"最近3次用过的篇章"都要按这张表来查。
CREATE TABLE IF NOT EXISTS attempt_questions (
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  ord INTEGER NOT NULL,              -- 本卷内重排后的题号 1..51
  question_id TEXT NOT NULL REFERENCES questions(question_id),
  section_id TEXT NOT NULL REFERENCES sections(section_id),
  section_ord INTEGER NOT NULL,      -- 第几部分 1..7
  score_per_question REAL NOT NULL,
  PRIMARY KEY (attempt_id, ord)
);
CREATE INDEX IF NOT EXISTS idx_aq_attempt ON attempt_questions(attempt_id);
CREATE INDEX IF NOT EXISTS idx_aq_section ON attempt_questions(section_id);

CREATE TABLE IF NOT EXISTS answer_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  question_id TEXT NOT NULL REFERENCES questions(question_id),
  user_answer TEXT,
  is_correct INTEGER,            -- NULL 表示还没判（作文等 AI）
  score REAL,
  ai_judged INTEGER NOT NULL DEFAULT 0,
  ai_score REAL,
  ai_comment TEXT,
  answered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
-- 一题一条记录，增量保存用 UPSERT
CREATE UNIQUE INDEX IF NOT EXISTS idx_answer_unique ON answer_records(attempt_id, question_id);
CREATE INDEX IF NOT EXISTS idx_answer_question ON answer_records(question_id);

CREATE TABLE IF NOT EXISTS user_knowledge_mastery (
  user_id INTEGER NOT NULL REFERENCES users(id),
  course_code TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES knowledge_points(tag_id),
  correct_count INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0,
  consecutive_correct INTEGER NOT NULL DEFAULT 0,
  last_result TEXT,
  last_practiced_at TEXT,
  PRIMARY KEY (user_id, course_code, tag_id)
);
