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

-- 加上状态判断：已经发布的不再重写，重复部署时这条是 0 行写入。
-- D1 免费版每天 10 万行写入，整套题库重写一次约 5700 行，很快就会撞上。
UPDATE questions SET status = '已发布' WHERE status NOT IN ('已发布', '存疑');

UPDATE exams
   SET status = '已发布', published_at = datetime('now')
 WHERE status != '已发布';

-- 单独扣下的题目：解析存疑且无法从原卷补全，留在库里但不参与组卷。
-- 13000-2026-04 第15题的官方答案提到 Kristina 被毒蜘蛛咬伤后迅速康复，
-- 但该题所配的 Veganism 短文全文没有这个人也没有这段情节，题干无从作答。
-- 标成"存疑"即可：抽题只认"已发布"，且整篇少一题就凑不满模板题量，
-- 所配的整个阅读理解选择部分会一并落选，不会拆散原文。
UPDATE questions SET status = '存疑'
 WHERE question_id = '13000-2026-04-q15' AND status != '存疑';
