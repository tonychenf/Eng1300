-- 改进阶段 2 第三期 F（2026-11-11）：考点整理里的"合并 A → B"（PRD 7.3）。
-- 合并会删掉 A，这张表记下 A 去了哪：
--   1. 追查——合并前 A 的全部数据（挂了哪些题、各学员的掌握度、下级、模板里的引用）存在 snapshot_json；
--   2. 以后加的题库文件还写着 A 的名字或编号时，种子按这张表挂到 B 上（scripts/build-seed-sql.mjs 的 tagIdSql），
--      知识点文件里 A 那一行也不再插回来。没有这张表的话，挂题目那一句外键报错，那一章导不进来。
-- 连着合并（A → B，后来 B → C）时，记着 into = B 的行跟着改成 C（routes/admin-kp.js），永远指向一个还在的考点。
-- 只建新表、不碰已有表。
CREATE TABLE IF NOT EXISTS knowledge_point_merges (
  from_tag_id TEXT PRIMARY KEY,
  from_name TEXT NOT NULL,
  subject_id INTEGER REFERENCES subjects(subject_id),
  into_tag_id TEXT NOT NULL REFERENCES knowledge_points(tag_id),
  snapshot_json TEXT,
  merged_by TEXT,
  merged_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kp_merges_into ON knowledge_point_merges(into_tag_id);
CREATE INDEX IF NOT EXISTS idx_kp_merges_name ON knowledge_point_merges(subject_id, from_name);
