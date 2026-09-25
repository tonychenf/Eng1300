-- M2: 题库、考点、AI配置、系统参数
-- 对应 docs/prd.md §8 数据模型

-- N1 学科骨架：学科是平台的顶层分区，也是权限边界与报告边界。
-- 见 docs/跨学科学习平台-需求文档.md §3.3（学科 → 课程 二级模型）。
CREATE TABLE IF NOT EXISTS subjects (
  subject_id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,          -- 进 URL、进导出文件名、进种子文件名，建科后不可改
  name TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT '启用' CHECK (status IN ('启用', '停用')),
  -- 内容组的排序依据只有一个整数（§6.4.2）；下面两个字段只作展示提示，
  -- 不允许任何逻辑分支依赖它们。
  content_group_kind TEXT NOT NULL DEFAULT 'EXAM_PAPER',
  ingest_pipeline TEXT NOT NULL DEFAULT 'json-direct',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_subjects_status ON subjects(status, sort_order);

CREATE TABLE IF NOT EXISTS courses (
  course_code TEXT PRIMARY KEY,
  course_name TEXT NOT NULL,
  -- 逻辑上 NOT NULL，但这里留空值余地：课程先于学科导入时能先落库再补挂。
  -- 真正的强制在题目契约校验里（§6.4.9），不靠这一层。
  subject_id INTEGER REFERENCES subjects(subject_id),
  time_limit_minutes INTEGER NOT NULL DEFAULT 150,
  total_score REAL NOT NULL DEFAULT 100
);
CREATE INDEX IF NOT EXISTS idx_courses_subject ON courses(subject_id);

CREATE TABLE IF NOT EXISTS exams (
  exam_id TEXT PRIMARY KEY,
  course_code TEXT NOT NULL REFERENCES courses(course_code),
  title TEXT NOT NULL,
  -- N6（§6.4.2）：内容组之间真正的结构性差异只有一件事——怎么排序。
  -- order_key 是唯一参与逻辑的字段（英语 year*100+month，生化章节号），
  -- label 是显示名，meta 是展示与筛选用的 JSON。排序、分页、"最近 N 个内容组"
  -- 对所有学科是同一条 SQL，不按 subjects.content_group_kind 分支。
  --
  -- 为什么不写成 NOT NULL：线上那张表是 N0 建的，补列只能走 ensure-columns.sh，
  -- 而 ALTER TABLE ADD COLUMN 的 NOT NULL 必须配一个默认值。给 order_key 配
  -- DEFAULT 0 的话，忘了写 order_key 的内容组会静默排到最前面。所以这里也留空，
  -- 两边形状一致（**新库与线上库结构分叉是 0002 那条老坑的根因**），
  -- "不许为空"由 ensure-columns.sh 的回填后检查和种子生成器各把一道。
  order_key INTEGER,
  label TEXT,
  meta TEXT,
  -- N6b：这个内容组是哪来的。SEED = 仓库里的种子文件导的，UPLOAD = 后台传的。
  -- **种子导入的 DELETE 只清 SEED 的**：不区分的话，下一次部署会把管理员在后台
  -- 上传并录好答案的整章连同学生的作答记录一起清掉——不报错，日志里也看不出来。
  origin TEXT,
  -- §6.4.2 说 year/month 放宽为可空。**这一条做不到**：SQLite 改不了 NOT NULL，
  -- 而 exams 有 sections/questions 两张子表引用，重建就要先清空题库（N3 那次事故
  -- 就是这么清掉线上题库的）。所以没有年月的学科写 0，并且**读出去的那一刻映射回
  -- null**（见 lib/content-group.js）——0 只存在于这张表里，任何界面都看不到它。
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
  -- N3：题型由学科在 subject_question_types 里声明，这里不能再写死枚举。
  -- 蓝本原来在这一列上有个只认三种英语题型的 CHECK；
  -- 生化有四种题型，第三个学科还会有别的，每加一科改一次约束是不可持续的。
  -- 注意：**不要把那条旧约束的原文抄进注释**。线上 D1 的 sqlite_master.sql 保留注释，
  -- 而重建脚本是按 DDL 文本判断新旧的——抄进来就会被当成"这还是旧表"，
  -- 于是每次部署都重清一次题库。本地 workerd 会把注释剥成空行，所以本地测不出来。
  -- 校验没有消失，只是挪到了发布路径上（admin-bank.js 的整卷发布会逐题查），
  -- 好处是拒绝时能说清楚"该学科声明了哪几种"，而 CHECK 只会给一句约束失败。
  question_type TEXT NOT NULL,
  stem TEXT,
  options TEXT,              -- JSON 数组字符串
  answer TEXT,
  answer_explanation TEXT,
  difficulty_tag TEXT,
  status TEXT NOT NULL DEFAULT '草稿'
    CHECK (status IN ('草稿', '已发布', '存疑')),
  reviewed INTEGER NOT NULL DEFAULT 0,
  -- N6（§6.4.10）：答案状态。**文档说的是给 status 加两格（缺答案 / 待核），
  -- 这里改成单开一列**，因为 status 上那条三值 CHECK 去不掉：去 CHECK 要重建
  -- questions，而它有五张子表引用，重建就要先清空题库——正是 N3 那次事故。
  -- 两处语义的分工：status 说"这道题校对到哪一步了"，answer_state 说"它的答案
  -- 能不能拿来判分"。抽题两个都要看（见 lib/pickable.js）。
  --
  -- 取值：缺答案 / 待核 / 已确认。**故意不加 CHECK**——这一列存在的理由就是
  -- 上一条 CHECK 加不进去也去不掉，再种一个一模一样的雷没有道理。
  -- 合法值在 lib/pickable.js 里，入口（种子生成、导入器、后台接口）各校验一次。
  answer_state TEXT,
  answer_source TEXT,          -- OFFICIAL / MANUAL / AI
  answer_reviewed_by TEXT,     -- 谁确认的这个答案
  answer_reviewed_at TEXT,
  -- 冗余自 courses.subject_id。题型校验、报告分层都要按学科过滤，
  -- 每次都 join 一次 courses 只为拿这一个值不划算。
  -- 写入方负责保持一致（种子生成器从 courses 现取）。
  subject_id INTEGER REFERENCES subjects(subject_id)
);
CREATE INDEX IF NOT EXISTS idx_questions_subject ON questions(subject_id, status);
-- 组卷与练习抽题的主查询路径：按课程+题型+状态筛选
CREATE INDEX IF NOT EXISTS idx_questions_pick ON questions(course_code, section_type, status);
CREATE INDEX IF NOT EXISTS idx_questions_exam ON questions(exam_id);
CREATE INDEX IF NOT EXISTS idx_questions_section ON questions(section_id);

CREATE TABLE IF NOT EXISTS knowledge_points (
  tag_id TEXT PRIMARY KEY,
  -- N3：name 原来是全局 UNIQUE。多学科之后这是个定时炸弹——英语和生化都可能
  -- 有叫"结构"的考点，第二个插不进去，而 INSERT OR IGNORE 让它悄悄丢掉。
  -- 降为 (subject_id, name) 唯一。
  name TEXT NOT NULL,
  category TEXT,
  subject_id INTEGER REFERENCES subjects(subject_id),
  -- 自引用，结构上支持任意层级（生化是 章 → 知识点 两层，英语是单层）。
  -- 界面默认展示两级，深度不由表结构限制。
  parent_tag_id TEXT REFERENCES knowledge_points(tag_id),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_kp_subject_name ON knowledge_points(subject_id, name);
CREATE INDEX IF NOT EXISTS idx_kp_parent ON knowledge_points(parent_tag_id);

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
  -- N6（§6.4.10）：区分"解析可能错了"与"原始资料本身就错了"。
  -- 两者处理方式不同：前者对着原件核对改解析，后者人工订正并留痕。
  note_kind TEXT,              -- 解析存疑 / 原题有误
  corrected_from TEXT,         -- 订正前原文
  corrected_to TEXT,           -- 订正后
  corrected_by TEXT,           -- 订正人（导入器自动订正的写管线名）
  corrected_at TEXT,
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

-- 三档 AI 配置。合法取值的唯一定义在 worker/src/lib/ai-purposes.js，
-- 这里的 CHECK 必须和它一致，由 worker/test/ai-purposes.test.mjs 对齐。
-- 注意：**不要把旧的取值清单抄进注释**。线上 D1 的 sqlite_master.sql 保留注释，
-- 而旧结构的检测就是按 DDL 文本判的，抄进注释会让它永远认为这张表是旧的
-- （踩过一次，见 docs/开发踩坑记录.md 第十节）。
CREATE TABLE IF NOT EXISTS ai_settings (
  purpose TEXT NOT NULL CHECK (purpose IN ('PARSING', 'TEXT_PARSING', 'TUTORING')),
  -- N3：0 表示全局兜底，>0 表示某个学科的覆盖。取值时先按学科找，找不到回落到 0。
  -- 故意不加外键：0 不是任何学科的 id，加了外键这一行就插不进去。
  subject_id INTEGER NOT NULL DEFAULT 0,
  base_url TEXT,
  api_key_encrypted TEXT,
  model TEXT,
  protocol TEXT NOT NULL DEFAULT 'openai',
  vision_capable INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (purpose, subject_id)
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
INSERT OR IGNORE INTO subjects (code, name, description, sort_order, content_group_kind, ingest_pipeline) VALUES
  ('english', '英语', '自考英语（二）/英语（专升本）历年真题', 1, 'EXAM_PAPER', 'pdf-ocr-llm'),
  ('biochem', '生物化学与分子生物学', '按教材章节组织的习题与解析（共 28 章）', 2, 'TEXTBOOK_CHAPTER', 'docx-structured');

INSERT OR IGNORE INTO courses (course_code, course_name, subject_id) VALUES
  ('00015', '英语(二)',     (SELECT subject_id FROM subjects WHERE code = 'english')),
  ('13000', '英语(专升本)', (SELECT subject_id FROM subjects WHERE code = 'english'));

-- 补挂：课程行可能是本次迁移之前就存在的（INSERT OR IGNORE 不会回头改它们）
UPDATE courses SET subject_id = (SELECT subject_id FROM subjects WHERE code = 'english')
 WHERE course_code IN ('00015', '13000') AND subject_id IS NULL;

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
