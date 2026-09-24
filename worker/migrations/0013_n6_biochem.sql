-- N6：生化学科的两项声明补齐。
--
-- 为什么要单独一条迁移而不是改 0009 的种子：0009 上了门闩（n3-pack-seed），
-- 线上不会再插一遍，改种子对已经落库的行毫无作用。要改就得像 0010 那样
-- 显式写 UPDATE，并且给它自己的门闩——否则管理员在后台改过的声明
-- 会被下一次部署冲回去，而且不报错。

-- ① 归一化器（§5.4）。生化的等价判断有两类蓝本没有的：
--    全角/半角与希腊字母（"α螺旋" 与 "alpha-螺旋" 与 "阿尔法螺旋"），
--    以及氨基酸的中英文命名（"半胱氨酸" 与 "Cys"）。
--    选择题也要 cjk-width，而且要排在 choice 前面：choice 只留 A-Z，
--    学生打出的全角 Ａ 会被它整个删掉，判成空答案。
UPDATE subject_question_types
   SET normalizers = '["cjk-width","choice"]'
 WHERE subject_id = (SELECT subject_id FROM subjects WHERE code = 'biochem')
   AND type_code = 'single_choice'
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n6-biochem-normalizers');

UPDATE subject_question_types
   SET normalizers = '["trim-case","cjk-width","chem-nomenclature"]'
 WHERE subject_id = (SELECT subject_id FROM subjects WHERE code = 'biochem')
   AND type_code = 'fill_text'
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n6-biochem-normalizers');

-- 名词解释与问答题不挂归一化器：学生写的是一整段，判分走采分点命中，
-- 在整段上做"氨基酸名折成三字母"这种替换只会把原文改花，帮不到判定。

INSERT OR IGNORE INTO seed_state (name, sha) VALUES ('n6-biochem-normalizers', 'v1');

-- ② 生化的课程行。学科是权限与报告边界，课程是题库的挂载点（§3.3），
--    题目、内容组都按 course_code 归属，没有这一行生化的题落库之后
--    subject_id 会是 NULL，而外键在 D1 上不强制，不报错。
INSERT OR IGNORE INTO courses (course_code, course_name, subject_id, time_limit_minutes, total_score)
VALUES ('biochem-main', '生物化学与分子生物学',
        (SELECT subject_id FROM subjects WHERE code = 'biochem'), 120, 100);

UPDATE courses SET subject_id = (SELECT subject_id FROM subjects WHERE code = 'biochem')
 WHERE course_code = 'biochem-main' AND subject_id IS NULL;
