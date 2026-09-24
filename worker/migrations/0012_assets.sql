-- N5b 富媒体题干：题目带资源，题干里按 key 引用（需求文档 §6.4.6）。
--
-- 到 N5 为止 questions.stem 是一个 TEXT 字段，整套 schema 里没有任何地方能放图片。
-- 这不是理科专属问题：物理电路图、化学结构式、历史地图、生物图解全进不来，
-- 而生化自己走到第 2 章核酸结构就需要碱基配对图。
--
-- **图片本身不进 D1**（G10）。文件随题库进仓库 data/subjects/<code>/assets/，
-- 随部署拷进 worker/public/bank/ 由 Worker 的 [assets] 托管；这张表只存元数据。
-- 图进库的话，一张 200KB 的 png 按 base64 存要 27 万字符，D1 每天 10 万行写入的
-- 额度本身不按字节算，但单行过大会让导入超时，而且备份和 diff 全毁了。
CREATE TABLE IF NOT EXISTS question_assets (
  question_id TEXT NOT NULL REFERENCES questions(question_id),
  -- 题干里 ![fig1] 引用的就是这个名字
  asset_key TEXT NOT NULL,
  subject_id INTEGER REFERENCES subjects(subject_id),
  kind TEXT NOT NULL DEFAULT 'IMAGE' CHECK (kind IN ('IMAGE', 'AUDIO')),
  -- 相对路径，如 biochem/ch02/base-pairing.png。相对于静态托管的 /bank/ 根。
  -- 不许以 / 开头、不许含 ..：它会被拼成 URL，既是数据约束也是一道边界。
  path TEXT NOT NULL,
  -- **必填**（对 IMAGE 而言）。这不是无障碍客套话，是功能约束：
  -- AI 看不到图，四类教学 AI 调用喂进去的都是题干文本，alt 空着模型会照着
  -- 残缺信息一本正经地编一段解析——不报错，但结果是错的。
  -- 喂 AI 前 ![key] 会被换成 [图：alt]（§6.4.6、G3）。
  alt TEXT,
  caption TEXT,
  PRIMARY KEY (question_id, asset_key)
);
CREATE INDEX IF NOT EXISTS idx_assets_subject ON question_assets(subject_id);
