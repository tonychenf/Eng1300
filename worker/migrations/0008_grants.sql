-- N2 学科权限。对应 docs/跨学科学习平台-需求文档.md §6.2。
--
-- 角色两级（用户确认）：SUPER_ADMIN 通吃所有学科，USER 按这张表授权。
-- 文档 §6.2.1 设计的是三级（多一个 SUBJECT_ADMIN），实际只有一个人管平台，
-- 简化成两级；同时保留 SUPER_ADMIN 这个名字而不改成 PLATFORM_ADMIN——
-- SQLite 改不了 CHECK 约束，重命名要重建 users 表并改遍前后端与测试，
-- 两级模型下这个名字本来就准确。

CREATE TABLE IF NOT EXISTS user_subject_grants (
  user_id INTEGER NOT NULL REFERENCES users(id),
  subject_id INTEGER NOT NULL REFERENCES subjects(subject_id),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  granted_by INTEGER REFERENCES users(id),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 空表示长期有效。比较一律用 datetime('now')（世界时），与库里其余时间字段同口径。
  expires_at TEXT,
  note TEXT,
  PRIMARY KEY (user_id, subject_id)
);
-- 主查询路径：判断"这个人能不能进这个学科"。主键已覆盖，这条给"某学科有哪些成员"用。
CREATE INDEX IF NOT EXISTS idx_grants_subject ON user_subject_grants(subject_id, status);

-- 授权变更留痕。谁在什么时候把谁的哪个学科改成了什么。
-- 这类写入属于记账：写失败不该拖垮授权本身，但不能没有。
CREATE TABLE IF NOT EXISTS subject_grant_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id),
  target_user_id INTEGER NOT NULL,
  subject_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('GRANT', 'REVOKE', 'UPDATE')),
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_grant_audit_target ON subject_grant_audit(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_grant_audit_subject ON subject_grant_audit(subject_id, created_at DESC);

-- 迁移前已有的学员：全部按"已开通全部学科"补上授权。
--
-- 不这么做的话，这次迁移一上线，所有现存学员当场失去全部访问权——本来能用的
-- 突然打不开，而且没人会把这件事和"加了权限功能"联系起来。权限是新增的约束，
-- 不该追溯剥夺既有访问。
--
-- 只能跑一次。流水线每次部署都会把 migrations/*.sql 全部重跑一遍，不加这道门的话
-- 管理员撤销过的授权会被下一次部署悄悄恢复——而且**不报任何错**：INSERT OR IGNORE
-- 只是没有冲突地插回去了，从日志上完全看不出来，等到有人发现"这个学员怎么还进得去"
-- 已经过了很久。用 seed_state 记一笔跑过了，与补授权同属一次 d1 execute --file 导入，
-- 要么都成要么都不成（蓝本踩过"数据进去了、指纹没记上"那个坑，见 CLAUDE.md 第三节）。
INSERT OR IGNORE INTO user_subject_grants (user_id, subject_id, note)
SELECT u.id, s.subject_id, 'N2 迁移：按既有访问补授权'
  FROM users u CROSS JOIN subjects s
 WHERE u.role = 'USER'
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n2-grant-backfill');

INSERT OR IGNORE INTO seed_state (name, sha) VALUES ('n2-grant-backfill', 'done');
