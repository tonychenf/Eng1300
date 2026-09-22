-- 记录每个种子文件已导入的内容指纹。
-- D1 免费版每天有 10 万行写入额度，而整套题库重新导入一次要写约 5700 行；
-- 只要内容没变就跳过，稳态部署的写入量降到 0。
CREATE TABLE IF NOT EXISTS seed_state (
  name TEXT PRIMARY KEY,
  sha TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
