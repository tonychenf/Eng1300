-- N0/N1 时期的旧结构快照，也就是线上 xlearn 库现在的样子。
-- 用途：给 scripts/ci/rebuild-legacy-schema.sh 提供一个真实的"旧库"来测。
-- 不要跟着 migrations/0002_bank.sql 一起改——它就是要冻在这儿，
-- 否则重建脚本测的是"新结构重建成新结构"，永远绿，也永远证明不了什么。
CREATE TABLE IF NOT EXISTS questions (
  question_id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(section_id),
  exam_id TEXT NOT NULL REFERENCES exams(exam_id),
  course_code TEXT NOT NULL,
  section_type TEXT NOT NULL,
  ord INTEGER NOT NULL,
  question_type TEXT NOT NULL
    CHECK (question_type IN ('single_choice', 'fill_blank_transform', 'essay')),
  stem TEXT,
  options TEXT,
  answer TEXT,
  answer_explanation TEXT,
  difficulty_tag TEXT,
  status TEXT NOT NULL DEFAULT '草稿'
    CHECK (status IN ('草稿', '已发布', '存疑')),
  reviewed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_questions_pick ON questions(course_code, section_type, status);
CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section_id);

CREATE TABLE IF NOT EXISTS knowledge_points (
  tag_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT
);

CREATE TABLE IF NOT EXISTS ai_settings (
  purpose TEXT PRIMARY KEY CHECK (purpose IN ('PARSING', 'TUTORING')),
  base_url TEXT,
  api_key_encrypted TEXT,
  model TEXT,
  protocol TEXT NOT NULL DEFAULT 'openai',
  vision_capable INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);
