-- AI 配置主键加学科维度：subject_id = 0 是全局兜底，>0 是某学科的覆盖。
-- 旧库里的两行都是全局配置，原样落到 0。
-- 注意这张表里存着加密后的 API Key，搬数据时原样带过去，不要重新加密也不要清空。
PRAGMA defer_foreign_keys = ON;

CREATE TABLE ai_settings_n3 (
  purpose TEXT NOT NULL CHECK (purpose IN ('PARSING', 'TUTORING')),
  subject_id INTEGER NOT NULL DEFAULT 0,
  base_url TEXT,
  api_key_encrypted TEXT,
  model TEXT,
  protocol TEXT NOT NULL DEFAULT 'openai',
  vision_capable INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT,
  PRIMARY KEY (purpose, subject_id)
);

INSERT INTO ai_settings_n3
  (purpose, subject_id, base_url, api_key_encrypted, model, protocol, vision_capable, updated_at)
SELECT purpose, 0, base_url, api_key_encrypted, model, protocol, vision_capable, updated_at
  FROM ai_settings;

DROP TABLE ai_settings;
ALTER TABLE ai_settings_n3 RENAME TO ai_settings;
