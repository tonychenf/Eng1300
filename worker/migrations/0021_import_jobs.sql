-- 改进阶段 2 第三期（2026-11-10）：AI 拆题导入（PRD 7.1）。传照片 → 后台排队识别 → 拆题 → 体检 → 逐页核对 → 入库。
--
-- **图片不进 D1**（用户 2026-11-07 定：识别完就丢）：排队那几分钟放在 KV（binding IMPORT_IMAGES），
-- 这里只记键；识别完（含可疑页当场的第二遍）立刻删 KV、键置空。理由见 PRD P3-C5：D1 每次部署前整库备份、
-- 时间旅行留 30 天，进了 D1 删了也还在；一张图写成一条 INSERT 还超过 D1 单条 100KB 的上限。
-- 只建新表、不碰已有表，没有要门闩的数据改动。

-- 一次导入：状态 上传中 → 待识别 → 识别中 → 拆题中 → 待核对 → 已入库；任一入库前的状态可放弃（已放弃）；拆题失败 → 失败
CREATE TABLE IF NOT EXISTS import_jobs (
  job_id TEXT PRIMARY KEY,
  subject_id INTEGER NOT NULL REFERENCES subjects(subject_id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  est_cost_yuan REAL,
  cost_yuan REAL NOT NULL DEFAULT 0,
  -- 拆出来的题（核对时改的也存在这里），入库时拼成题库文件交给 planGroupImport
  draft_json TEXT,
  -- 入库后的内容组；删除内容组时置空（任务记录留着）
  exam_id TEXT,
  error TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_import_jobs_status ON import_jobs(status);

-- 一页：状态 待识别 → 识别中 → 已识别 / 失败；重拍回到待识别
CREATE TABLE IF NOT EXISTS import_pages (
  job_id TEXT NOT NULL REFERENCES import_jobs(job_id),
  page_no INTEGER NOT NULL,              -- 上传顺序，从 1 起
  printed_page INTEGER,                  -- 模型读出的书上印的页码
  image_key TEXT,                        -- 排队时图片在 KV 里的键；识别完即删、置空
  status TEXT NOT NULL,
  text TEXT,                             -- 识别出的文字
  text_alt TEXT,                         -- 可疑页当场第二遍识别的文字
  issues_json TEXT,                      -- 这一页的体检结果（逐页能查的那几条）
  reviewed INTEGER NOT NULL DEFAULT 0,   -- 核对时点了"这页没问题"
  attempts INTEGER NOT NULL DEFAULT 0,
  cost_yuan REAL NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (job_id, page_no)
);
CREATE INDEX IF NOT EXISTS idx_import_pages_status ON import_pages(status);
