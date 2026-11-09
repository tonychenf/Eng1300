-- 改进阶段 2 第二期（2026-11-09）：后台「识别实测」——拿几页真实照片比几个读图模型，挑模型用。PRD 第 6 节。
--
-- **图片不进库**（用户 2026-11-07 定：识别完就丢）。这里只存每次识别出的文字、耗时、花费和算出来的指标。
-- 只建新表、不碰已有表，没有要门闩的数据改动。

-- 一次实测：选了哪些页、哪些模型（带各自的单价）、哪些压缩尺寸
CREATE TABLE IF NOT EXISTS ocr_bench_runs (
  id TEXT PRIMARY KEY,
  created_by INTEGER,
  config_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 一页 × 一个模型 × 一种尺寸 的识别结果。metrics_json 由页面在浏览器里算好存回来（编辑距离在 Worker 里算不动）
CREATE TABLE IF NOT EXISTS ocr_bench_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bench_id TEXT NOT NULL REFERENCES ocr_bench_runs(id),
  page INTEGER NOT NULL,
  model TEXT NOT NULL,
  size INTEGER NOT NULL,
  text TEXT,
  latency_ms INTEGER,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_yuan REAL,
  error TEXT,
  metrics_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ocr_bench_results ON ocr_bench_results(bench_id);
