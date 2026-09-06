-- 登录失败限流（PRD §5.1.1）：连续5次失败锁定该用户名10分钟
CREATE TABLE IF NOT EXISTS login_attempts (
  username TEXT PRIMARY KEY,
  fail_count INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_failed_at TEXT
);
