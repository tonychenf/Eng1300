-- 放宽 ai_settings.purpose 的取值，给「文字解析 AI」腾一档（N7d）。
--
-- SQLite 改不了 CHECK，只能重建表。这张表没有任何外键指向它，所以重建是干净的
-- （questions / exams 那两张就不行，见 docs/开发踩坑记录.md 第十二节）。
--
-- **这张表里存着加密后的 API Key。** 搬丢了线上 AI 全废，而且直到有人用才会发现，
-- 所以先建新表、把数据搬过去、再删旧表，全部在同一个 --file 里执行。
-- 调用方在跑完之后会核对行数，对不上就让部署当场失败。
PRAGMA defer_foreign_keys = ON;

CREATE TABLE ai_settings_n7d (
  purpose TEXT NOT NULL CHECK (purpose IN ('PARSING', 'TEXT_PARSING', 'TUTORING')),
  subject_id INTEGER NOT NULL DEFAULT 0,
  base_url TEXT,
  api_key_encrypted TEXT,
  model TEXT,
  protocol TEXT NOT NULL DEFAULT 'openai',
  vision_capable INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (purpose, subject_id)
);

INSERT INTO ai_settings_n7d
  (purpose, subject_id, base_url, api_key_encrypted, model, protocol, vision_capable, updated_at)
SELECT purpose, subject_id, base_url, api_key_encrypted, model, protocol, vision_capable, updated_at
  FROM ai_settings;

DROP TABLE ai_settings;
ALTER TABLE ai_settings_n7d RENAME TO ai_settings;
