-- 改进阶段 2 第三期 D（2026-11-11）：批量核对答案（PRD 7.2）。每道题核答案时要看的几个疑点，排队用。
--   confidence    AI 出答案时自己说有多确定（高 / 中 / 低；读不懂就空）
--   stem_problem  做题反查：AI 出答案时说题面有问题（题干不完整、选项不成立、没有正确选项…）
--   handwritten   拆题时读出的书上手写答案（第三期 C1 导入的题）
--   book_answer   原书答案页上读出的答案（上传答案页比对时写）
-- 只建新表、不碰已有表。删内容组时要连它一起删（routes/admin-import.js 的 DELETE，CLAUDE.md 那条规矩）。
CREATE TABLE IF NOT EXISTS answer_review_flags (
  question_id TEXT PRIMARY KEY REFERENCES questions(question_id),
  confidence TEXT,
  stem_problem TEXT,
  handwritten TEXT,
  book_answer TEXT,
  book_checked_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
