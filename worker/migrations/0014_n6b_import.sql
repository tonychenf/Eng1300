-- N6b：后台上传的内容组，留下解析出来的纯文本，不留原件。
--
-- 用户明确要的：**解析完把源文件丢弃，只留解析之后的内容**。所以原件从头到尾
-- 只在 Worker 的内存里过一遍，不写 R2、不写 D1。这张表存的是从 docx 里抽出来的
-- 段落文本，校对时能对着看"原文这一段到底怎么写的"。
--
-- 代价说清楚：**解析器改进之后无法重跑**。题目里回写的 sourcePara 仍然指得到
-- 这张表里的段落，但指不回 docx 了。要重新解析只能请人再传一次原件。
CREATE TABLE IF NOT EXISTS content_group_sources (
  exam_id TEXT PRIMARY KEY REFERENCES exams(exam_id),
  -- 只留文件名与字节数，用来对账"我传的是不是那个文件"，不留内容
  filename TEXT,
  byte_size INTEGER,
  pipeline TEXT NOT NULL,
  -- JSON 数组：解析器抽出来的段落纯文本，按原顺序
  paragraphs TEXT NOT NULL,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
);
