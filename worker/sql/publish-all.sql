-- 一次性放行：把全部解析存疑记录标记为已处理，并发布所有试卷与题目。
--
-- 这一步是用户明确要求的（"去掉所有79条解析存疑记录并进行发布"）。它绕过了
-- 后台"存疑清零才能发布"的门槛，因此这些存疑点并没有被人工核对过，只是被
-- 标记成已处理。具体存疑内容仍完整保留在 data/exams/REVIEW_NOTES.md 与
-- exam_parsing_notes 表里，随时可以回头逐条核。
--
-- 必须在导入题库之后执行：seed 脚本按试卷"先删后插"，会把状态重置回草稿、
-- 把存疑记录重新插回来。

UPDATE exam_parsing_notes
   SET resolved = 1, resolved_at = datetime('now')
 WHERE resolved = 0;

UPDATE questions SET status = '已发布' WHERE status != '存疑';

UPDATE exams
   SET status = '已发布', published_at = datetime('now')
 WHERE status != '已发布';
