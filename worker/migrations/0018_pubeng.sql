-- 第三个学科：公共英语（2026-11-07，用户要开的新课）。
--
-- 资料是《公共英语课程 教学重点与考试样卷》的扫描件：两组选择题强化训练、第四段教学重点（单词、词组、
-- 句子翻译、精选段落）、第四段考试样卷。用户定的是**独立学科**，不挂在「英语」下：
-- 题型（拼写单词、词组翻译、句子翻译、段落翻译）自考英语没有，权限、考点、报告也要分开。
--
-- 和生化一样，学科的全部声明都在这一条迁移里：学科行、课程行、题型、评价标准、解析字段、
-- 四类 AI 提示词、组卷模板。漏一样就是"不报错但用不了"（0013、0017 补的都是生化当初漏的）。
--
-- 门闩（两个）：迁移每次部署都全部重跑，管理员在后台改过、删过的声明不能被
-- INSERT OR IGNORE 插回去（N2 授权那条老坑）。门闩只在声明真的落库了才合上。

-- ① 学科与课程。学科码进 URL、进种子文件名，建了就不能改。
INSERT OR IGNORE INTO subjects (code, name, description, sort_order, content_group_kind, ingest_pipeline)
VALUES ('pubeng', '公共英语', '公共英语课程（《大学英语》精读）：教学重点、选择题强化训练与考试样卷', 3,
        'TEXTBOOK_CHAPTER', 'json-direct');

-- 时长：样卷上没写，先按 120 分钟（和生化一样），后台可改。
INSERT OR IGNORE INTO courses (course_code, course_name, subject_id, time_limit_minutes, total_score)
VALUES ('pubeng-main', '公共英语', (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 120, 100);
UPDATE courses SET subject_id = (SELECT subject_id FROM subjects WHERE code = 'pubeng')
 WHERE course_code = 'pubeng-main' AND subject_id IS NULL;

-- ② 题型：作答形态 × 判分策略（§6.4.4）。
--    单项选择：选择填空、段落填空（从词库里选，词库按 A–O 编号）、阅读理解都用它，靠大题类型区分。
--    拼写单词：给中文写英文单词，精确比对；en-spelling 折叠英美拼写（colour/color）。
--    三种翻译：译文措辞千差万别，规则判不了，按采分点 AI 批改（和生化的名词解释、问答同一套）。
--    练习不调 AI，这三种题在练习里如实显示"练习不判分"、列出参考译文和采分点。
INSERT OR IGNORE INTO subject_question_types
  (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss,
   normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 'single_choice', '单项选择', 1, 1, 0, 'choice', 0,
       '["cjk-width","choice"]', 1, 'CHOICE_ONE', 'EXACT'
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');
INSERT OR IGNORE INTO subject_question_types
  (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss,
   normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 'spell_word', '拼写单词', 1, 1, 0, 'text', 0,
       '["en-spelling"]', 2, 'TEXT_SHORT', 'EXACT'
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');
INSERT OR IGNORE INTO subject_question_types
  (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss,
   normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 'phrase_translate', '词组翻译', 0, 1, 1, 'text', 0,
       '[]', 3, 'TEXT_SHORT', 'AI_SCORE_POINTS'
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');
INSERT OR IGNORE INTO subject_question_types
  (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss,
   normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 'sentence_translate', '句子翻译', 0, 1, 1, 'textarea', 0,
       '[]', 4, 'TEXT_LONG', 'AI_SCORE_POINTS'
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');
INSERT OR IGNORE INTO subject_question_types
  (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss,
   normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 'paragraph_translate', '段落翻译', 0, 1, 1, 'textarea', 0,
       '[]', 5, 'TEXT_LONG', 'AI_SCORE_POINTS'
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');

-- ③ 评价标准。partialCredit=true：翻译题按采分点给部分分（一道 3 分的句子翻译译对一半给一半）。
--    客观题都是单单元，这个开关对它们没有影响（判在题一级，见 grade.js）。
INSERT OR IGNORE INTO subject_rubrics (subject_id, version, payload, is_current)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 1, '{"grading":{"partialCredit":true,"caseSensitive":false},"essay":{"type":"POINT_HIT","totalScore":100,"openWeightCap":0.4,"note":"翻译题按采分点命中判：得分率 = 命中权重 / 总权重。"},"mastery":{"masteredMinTotal":3,"masteredMinStreak":3,"weakRateBelow":0.5,"correctThreshold":1.0,"weights":{"untested":2.0,"lastWrong":5.0,"byStreak":[{"upTo":1,"weight":2.0},{"upTo":2,"weight":1.0},{"upTo":null,"weight":0.3}]}},"passLine":60,"fullScore":100}', 1
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');

INSERT OR IGNORE INTO subject_explanation_schema (subject_id, fields, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), '[{"key":"answerBasis","label":"答案依据","required":true,"widget":"textarea"},{"key":"distractors","label":"干扰项分析","required":false,"widget":"textarea"},{"key":"knowledge","label":"考点归纳","required":true,"widget":"textarea"}]', datetime('now')
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');

-- ④ AI 提示词。主观题批改直接用按采分点批的那份（0017 给生化换上的同一套变量），
--    不再先种一份照抄英语作文的、再迁移去换。
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 'essay_grade', '你是一位大学公共英语课程的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '按下面的采分点批改这道{{subjectName}}翻译题。只看意思译没译对、关键词和句型用没用对，不因标点、大小写或与参考译文措辞不同扣分。

题目：
{{stem}}

学生答案：
{{answer}}

{{pointLines}}

只输出这个 JSON：
{{jsonShape}}', datetime('now')
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 'wrong_analyze', '你是一位大学公共英语课程的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '分析学生这道题做错的原因。

{{passageBlock}}题干：{{stem}}
{{optionsBlock}}学生答案：{{userAnswer}}
正确答案：{{correctAnswer}}
考点：{{knowledgePoints}}

只输出这个 JSON，两个字段都用中文，各 80 字以内：
{"errorReason":"错在哪、为什么","memoryPoint":"下次遇到同类题该记住什么"}', datetime('now')
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 'answer_explain', '你是一位大学公共英语课程的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '给学生讲解这道题。

{{passageBlock}}题干：{{stem}}
{{optionsBlock}}学生答案：{{userAnswer}}
正确答案：{{correctAnswer}}
学生{{correctness}}。

只输出这个 JSON，explanation 用中文、200 字以内：
{"explanation":""}', datetime('now')
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'pubeng'), 'assessment', '你是一位大学公共英语课程的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '根据下面这位公共英语考生的数据，给出能力评估。满分 {{fullScore}} 分。

各考点掌握情况：
{{masteryLines}}

最近错题集中的考点：{{recentWrongTags}}
历次模考总分（由旧到新）：{{scoreTrend}}
统计模型给出的预测分：{{predictedScore}}

只输出这个 JSON：
{"predictedLow":0,"predictedHigh":0,"levelDesc":"一句话水平定位",
 "weakPoints":["考点1","考点2"],"suggestions":["建议1","建议2","建议3"]}', datetime('now')
 WHERE EXISTS (SELECT 1 FROM subjects WHERE code = 'pubeng')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-pack-seed');

INSERT OR IGNORE INTO seed_state (name, sha)
SELECT 'pubeng-pack-seed', 'v1'
 WHERE EXISTS (SELECT 1 FROM subject_question_types
                WHERE subject_id = (SELECT subject_id FROM subjects WHERE code = 'pubeng'));

-- ⑤ 组卷模板：照第四段试卷说明（原书第 132 页），7 个部分 81 题 100 分。
--    数值与 data/subjects/pubeng/exam-template.json 逐项一致，测试拿那个文件现算期望值来对。
--    阅读理解是两篇各 5 题（样卷就是这样），拆成两个整篇抽的模板项；同一张卷不会两项抽到同一篇
--    （paper.js 的 usedSections，2026-11-07 为此补的）。
--    选择填空、段落填空、阅读理解都是单项选择，按大题类型（sectionTypes）区分。
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'pubeng-main', 1, '拼写单词', '{"questionTypes":["spell_word"]}', 20, 'FROM_TEMPLATE', 0.5, 'QUESTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'pubeng-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'pubeng-main', 2, '词组翻译', '{"questionTypes":["phrase_translate"]}', 10, 'FROM_TEMPLATE', 1, 'QUESTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'pubeng-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'pubeng-main', 3, '选择填空', '{"sectionTypes":["选择填空"]}', 25, 'FROM_TEMPLATE', 1, 'QUESTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'pubeng-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'pubeng-main', 4, '段落填空', '{"sectionTypes":["段落填空"]}', 10, 'FROM_TEMPLATE', 1, 'SECTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'pubeng-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'pubeng-main', 5, '阅读理解（一）', '{"sectionTypes":["阅读理解"]}', 5, 'FROM_TEMPLATE', 2, 'SECTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'pubeng-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'pubeng-main', 6, '阅读理解（二）', '{"sectionTypes":["阅读理解"]}', 5, 'FROM_TEMPLATE', 2, 'SECTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'pubeng-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'pubeng-main', 7, '句子翻译', '{"questionTypes":["sentence_translate"]}', 5, 'FROM_TEMPLATE', 3, 'QUESTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'pubeng-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-exam-template');
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT 'pubeng-main', 8, '段落翻译', '{"questionTypes":["paragraph_translate"]}', 1, 'FROM_TEMPLATE', 10, 'QUESTION'
 WHERE EXISTS (SELECT 1 FROM courses WHERE course_code = 'pubeng-main')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'pubeng-exam-template');

INSERT OR IGNORE INTO seed_state (name, sha)
SELECT 'pubeng-exam-template', 'v1'
 WHERE EXISTS (SELECT 1 FROM exam_template_items WHERE course_code = 'pubeng-main');
