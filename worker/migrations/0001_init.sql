CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'USER')),
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT,
  -- CR-M2：登录令牌的版本号，重置/修改密码、停用时加一，旧令牌随之失效。
  -- 线上那张表是早先建的，这一列由 scripts/ci/ensure-columns.sh 补（CREATE TABLE IF NOT EXISTS
  -- 对已有表一行都不改）；新库从这里一次建对，两边形状一致。
  token_version INTEGER NOT NULL DEFAULT 0
);
