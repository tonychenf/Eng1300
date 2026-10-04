-- 生化模考补齐（2026-10-04）：组卷模板进库、主观题批改提示词改成按采分点批。
--
-- 为什么要这条迁移：生化的组卷模板早就定了（需求文档 §6.4.8，12:13:7:2、100 分），
-- 写在 data/subjects/biochem/exam-template.json 里，却没有任何迁移、脚本、代码去读它。
-- 组卷只认库里的 exam_template_items，于是生化一点「生成试卷」就是 422
-- "该课程没有配置组卷模板"。和 0013 补课程行、归一化器是同一类漏：生化的声明没落库。
--
-- 两段各带门闩，只执行一次：以后在库里改过、删过的，部署不会冲回去也不会插回来
-- （迁移每次部署都全部重跑，INSERT OR IGNORE 会把删掉的行插回来——N2 授权那条老坑）。

-- ① 组卷模板。数值与 exam-template.json 逐项一致，bio-exam.sh 拿那个文件现算期望值来对。
--    fill_numeric 照抄文件：生化现在没有这个题型，IN 里多一个值不影响抽题。
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'biochem-main', 1, '填空题', '{"questionTypes":["fill_text","fill_numeric"]}', 12, 'FROM_TEMPLATE', 2, 'QUESTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'biochem-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'biochem-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'biochem-main', 2, '选择题', '{"questionTypes":["single_choice"]}', 13, 'FROM_TEMPLATE', 2, 'QUESTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'biochem-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'biochem-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'biochem-main', 3, '名词解释', '{"questionTypes":["term_explain"]}', 7, 'FROM_TEMPLATE', 4, 'QUESTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'biochem-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'biochem-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'biochem-main', 4, '问答题', '{"questionTypes":["short_answer"]}', 2, 'FROM_TEMPLATE', 11, 'QUESTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'biochem-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'biochem-exam-template');

-- 门闩只在模板真的装上了才合上：课程行不在（理论上 0013 已经建了）时下次部署还会再试。
INSERT OR IGNORE INTO seed_state (name, sha)
SELECT 'biochem-exam-template', 'v1'
 WHERE EXISTS (SELECT 1 FROM exam_template_items WHERE course_code = 'biochem-main');

-- ② 生化的「主观题批改」提示词。0009 种进去的是照抄英语作文的那份（"写作要求""学生作文"
--    "维度"），而生化的名词解释、问答是按采分点判的（评价标准 essay.type = POINT_HIT）。
--    只在它**还是 0009 的原文**时改：后台「能力包」页改过的，一个字不动。
--    变量名换成说人话的 {{stem}} {{answer}} {{pointLines}}；代码同时也给旧名字
--    （{{prompt}} {{essay}} {{dimensionLines}}）传值，后台改过的旧模板照样渲染得出来。
UPDATE subject_ai_prompts
   SET user_template = '按下面的采分点批改这道{{subjectName}}主观题。

题目：
{{stem}}

学生答案：
{{answer}}

{{pointLines}}

只输出这个 JSON：
{{jsonShape}}',
       updated_at = datetime('now')
 WHERE subject_id = (SELECT subject_id FROM subjects WHERE code = 'biochem')
   AND feature = 'essay_grade'
   AND user_template = '按下面的评分标准批改这道生物化学主观题。

写作要求：
{{prompt}}

学生作文：
{{essay}}

{{dimensionLines}}

只输出这个 JSON：
{{jsonShape}}'
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'biochem-subjective-prompt');

INSERT OR IGNORE INTO seed_state (name, sha) VALUES ('biochem-subjective-prompt', 'v1');
