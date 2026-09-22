-- M2: 题库、考点、AI配置、系统参数
-- 对应 docs/prd.md §8 数据模型

CREATE TABLE IF NOT EXISTS courses (
  course_code TEXT PRIMARY KEY,
  course_name TEXT NOT NULL,
  time_limit_minutes INTEGER NOT NULL DEFAULT 150,
  total_score REAL NOT NULL DEFAULT 100
);

CREATE TABLE IF NOT EXISTS exams (
  exam_id TEXT PRIMARY KEY,
  course_code TEXT NOT NULL REFERENCES courses(course_code),
  title TEXT NOT NULL,
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  source_file TEXT,
  status TEXT NOT NULL DEFAULT '待校对'
    CHECK (status IN ('解析中', '待校对', '已发布', '已废弃', '解析失败')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_exams_course_status ON exams(course_code, status);

CREATE TABLE IF NOT EXISTS sections (
  section_id TEXT PRIMARY KEY,
  exam_id TEXT NOT NULL REFERENCES exams(exam_id),
  type TEXT NOT NULL,
  ord INTEGER NOT NULL,
  passage_title TEXT,
  passage_text TEXT,
  writing_prompt TEXT,
  score_per_question REAL,
  total_score REAL
);
CREATE INDEX IF NOT EXISTS idx_sections_exam ON sections(exam_id);

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
  options TEXT,              -- JSON 数组字符串
  answer TEXT,
  answer_explanation TEXT,
  difficulty_tag TEXT,
  status TEXT NOT NULL DEFAULT '草稿'
    CHECK (status IN ('草稿', '已发布', '存疑')),
  reviewed INTEGER NOT NULL DEFAULT 0
);
-- 组卷与练习抽题的主查询路径：按课程+题型+状态筛选
CREATE INDEX IF NOT EXISTS idx_questions_pick ON questions(course_code, section_type, status);
CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section_id);

CREATE TABLE IF NOT EXISTS knowledge_points (
  tag_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  category TEXT
);

CREATE TABLE IF NOT EXISTS question_knowledge_points (
  question_id TEXT NOT NULL REFERENCES questions(question_id),
  tag_id TEXT NOT NULL REFERENCES knowledge_points(tag_id),
  PRIMARY KEY (question_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_qkp_tag ON question_knowledge_points(tag_id);

-- 解析时产生的存疑记录，发布前必须逐条处理（PRD §5.3.2）
CREATE TABLE IF NOT EXISTS exam_parsing_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  exam_id TEXT NOT NULL REFERENCES exams(exam_id),
  note TEXT NOT NULL,
  resolved INTEGER NOT NULL DEFAULT 0,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notes_exam ON exam_parsing_notes(exam_id, resolved);

CREATE TABLE IF NOT EXISTS exam_templates (
  course_code TEXT NOT NULL REFERENCES courses(course_code),
  ord INTEGER NOT NULL,
  section_type TEXT NOT NULL,
  question_count INTEGER NOT NULL,
  score_per_question REAL NOT NULL,
  PRIMARY KEY (course_code, ord)
);

-- 两套 AI 配置：PARSING(题库解析) / TUTORING(教学)
CREATE TABLE IF NOT EXISTS ai_settings (
  purpose TEXT PRIMARY KEY CHECK (purpose IN ('PARSING', 'TUTORING')),
  base_url TEXT,
  api_key_encrypted TEXT,
  model TEXT,
  protocol TEXT NOT NULL DEFAULT 'openai',
  vision_capable INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS system_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS ai_usage_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purpose TEXT NOT NULL,
  feature TEXT,
  tokens_in INTEGER DEFAULT 0,
  tokens_out INTEGER DEFAULT 0,
  latency_ms INTEGER,
  success INTEGER NOT NULL DEFAULT 1,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_created ON ai_usage_logs(created_at);

-- 初始数据
INSERT OR IGNORE INTO courses (course_code, course_name) VALUES
  ('00015', '英语(二)'),
  ('13000', '英语(专升本)');

INSERT OR IGNORE INTO system_settings (key, value, description) VALUES
  ('practice.diagnostic_batch_size', '40', '学习模块摸底阶段单批最多覆盖的考点数'),
  ('practice.reinforce_recent_window', '20', '强化阶段避免重复出题的最近题目数窗口'),
  ('exam.recent_passage_avoid', '3', '组卷时规避最近N次模考出现过的篇章');

-- 两门课程的组卷模板（PRD §4.2）
INSERT OR IGNORE INTO exam_templates (course_code, ord, section_type, question_count, score_per_question) VALUES
  ('00015', 1, '阅读判断', 10, 1),
  ('00015', 2, '阅读理解选择', 5, 2),
  ('00015', 3, '段落大意与句子补全', 10, 1),
  ('00015', 4, '填句补文', 5, 2),
  ('00015', 5, '填词补文', 10, 1.5),
  ('00015', 6, '完形填空', 10, 1.5),
  ('00015', 7, '写作', 1, 30),
  ('13000', 1, '阅读判断', 10, 1),
  ('13000', 2, '阅读理解选择', 5, 2),
  ('13000', 3, '段落大意与句子补全', 10, 1),
  ('13000', 4, '填句补文', 5, 2),
  ('13000', 5, '填词补文', 10, 1.5),
  ('13000', 6, '完形填空', 10, 1.5),
  ('13000', 7, '写作', 1, 30);
