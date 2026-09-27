-- 部署时的「放行」（CR-H2）：只把**重导前就是已发布**、这次又被种子重导冲回草稿的章节放回去。
--
-- 标记由 scripts/ci/seed-if-changed.sh 写进 seed_state（name = 'republish:<exam_id>'），
-- 与那一章的导入同属一次 d1 execute --file；这里放完就删，也与放行同属一次执行。
-- 所以导题库中途失败、或者这一步本身失败，标记都还在，下次部署接着放。
--
-- 以前这一步是无条件跑 publish-all.sql：每次部署都把所有"答案已确认"的题放出去、
-- 把所有存疑标成已处理——管理员撤回的章节被放回去、确认完答案还没点发布的章节被发布、
-- 上传内容里没人看过的存疑被清零。publish-all.sql 现在只给本地测试造数据用。
--
-- 没有标记时下面四条都是 0 行写入（D1 免费版每天 10 万行，稳态部署不该花掉任何一行）。

-- 这几章的存疑是随重导重新插回来的，重导前它们已经处理过（否则发布不了）
UPDATE exam_parsing_notes
   SET resolved = 1, resolved_at = datetime('now')
 WHERE resolved = 0
   AND exam_id IN (SELECT substr(name, 11) FROM seed_state WHERE name LIKE 'republish:%');

-- 答案没确认的题不放（§6.4.10、B14）；存疑点名的题也不放
UPDATE questions SET status = '已发布'
 WHERE status NOT IN ('已发布', '存疑') AND answer_state = '已确认'
   AND exam_id IN (SELECT substr(name, 11) FROM seed_state WHERE name LIKE 'republish:%');

-- 一道题都放不出来的章节不标成已发布（后台会显示一个点进去什么都没有的"已发布"章节）
UPDATE exams
   SET status = '已发布', published_at = datetime('now')
 WHERE status != '已发布'
   AND exam_id IN (SELECT substr(name, 11) FROM seed_state WHERE name LIKE 'republish:%')
   AND EXISTS (SELECT 1 FROM questions q WHERE q.exam_id = exams.exam_id AND q.status = '已发布');

DELETE FROM seed_state WHERE name LIKE 'republish:%';
