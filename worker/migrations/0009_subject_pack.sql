-- N3 学科能力包：把蓝本里写死的英语规则搬进数据。
-- 见 docs/跨学科学习平台-需求文档.md §5（能力包）与 §5.1（要消除的硬编码清单）。
--
-- 原则（§5.3）：能用数据表达的一律用数据，只有"语义判断"才允许写代码。
-- 所以题型、评分维度与权重、掌握度阈值、提示词、参数覆盖全在这里；
-- 归一化器（语义等价判断）在 worker/src/normalizers/ 里，学科只声明引用哪几个。

-- ---------- 题型声明（消除 §5.1 #1、#10） ----------
CREATE TABLE IF NOT EXISTS subject_question_types (
  subject_id INTEGER NOT NULL REFERENCES subjects(subject_id),
  type_code TEXT NOT NULL,
  name TEXT NOT NULL,
  is_objective INTEGER NOT NULL DEFAULT 1,   -- 规则可判；0 表示要 AI 或人工
  in_practice INTEGER NOT NULL DEFAULT 1,    -- 是否进专项练习（蓝本写死排除 essay）
  needs_ai INTEGER NOT NULL DEFAULT 0,
  -- N5 补：题型 = **作答形态 × 判分策略**两个正交维度（§6.4.4）。
  -- 只写一个名字（"填空题"）的话，第三个学科要排序题、匹配题、人工判分就得回头
  -- 改这张表和判分骨架——那正是这次改造要消灭的东西。
  answer_shape TEXT,       -- CHOICE_ONE / CHOICE_MANY / TEXT_SHORT / NUMBER / TEXT_LONG / ORDERING / MATCHING
  -- 默认判分策略，得分单元可以逐个覆盖（question_items.grading_strategy）。
  -- 取值见 src/graders/index.js 的注册表。**可空是给旧库留的**：线上那张表是 N3
  -- 建的，没有这两列，只能由 scripts/ci/ensure-columns.sh 补上再回填。
  grading_strategy TEXT,
  input_widget TEXT NOT NULL DEFAULT 'text', -- 作答控件：choice / text / textarea
  -- 规则判错之后要不要再交给 AI 复核。选择题的答案是闭集，复核没有意义；
  -- 自由填空才值得复核。蓝本把这条写死在 gradeQuestion 的 if 分支里。
  ai_review_on_miss INTEGER NOT NULL DEFAULT 0,
  normalizers TEXT NOT NULL DEFAULT '[]',    -- JSON 数组，引用 src/normalizers/ 里的能力
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (subject_id, type_code)
);

-- ---------- 评价标准（消除 §5.1 #6、#7、#8） ----------
-- 带版本：改标准不能改动历史报告的分数（§14.2 F9），所以旧版本要留着，
-- attempts 记下当次用的是哪一版。一个学科同时只有一行 is_current = 1。
CREATE TABLE IF NOT EXISTS subject_rubrics (
  subject_id INTEGER NOT NULL REFERENCES subjects(subject_id),
  version INTEGER NOT NULL,
  payload TEXT NOT NULL,                     -- JSON，结构见 lib/subject-pack.js 顶部
  is_current INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (subject_id, version)
);
CREATE INDEX IF NOT EXISTS idx_rubrics_current ON subject_rubrics(subject_id, is_current);

-- ---------- 解析结构定义 ----------
CREATE TABLE IF NOT EXISTS subject_explanation_schema (
  subject_id INTEGER PRIMARY KEY REFERENCES subjects(subject_id),
  fields TEXT NOT NULL,                      -- JSON 数组，每项 {key,label,required,widget}
  updated_at TEXT
);

-- ---------- AI 提示词（消除 §5.1 #5） ----------
-- subject_id = 0 是全局兜底：新建学科还没配提示词时不至于整块功能不可用。
-- 故意不加外键，0 不是任何学科的 id。
CREATE TABLE IF NOT EXISTS subject_ai_prompts (
  subject_id INTEGER NOT NULL DEFAULT 0,
  feature TEXT NOT NULL,                     -- essay_grade / wrong_analyze / answer_explain / assessment
  system_prompt TEXT NOT NULL,
  user_template TEXT NOT NULL,               -- {{占位符}} 由调用方填
  updated_at TEXT,
  PRIMARY KEY (subject_id, feature)
);

-- ---------- 学科级参数覆盖（消除 §5.1 #11 的后半） ----------
-- system_settings 保留为全局默认，这里只放覆盖。取值顺序：学科 → 全局 → 报错。
CREATE TABLE IF NOT EXISTS subject_settings (
  subject_id INTEGER NOT NULL REFERENCES subjects(subject_id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  description TEXT,
  PRIMARY KEY (subject_id, key)
);

-- ---------- 两个学科的能力包种子 ----------
-- 门闩：管理员改过或删过的配置，不能被下一次部署的 INSERT OR IGNORE 恢复。
-- N2 那次就是漏了门闩，撤销掉的授权会被下次部署悄悄插回去，不报错也看不出来。
-- 门闩记录与被门闩的写入同属一次 d1 execute --file。

INSERT OR IGNORE INTO subject_question_types (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss, normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'english'), 'single_choice', '单项选择', 1, 1, 0, 'choice', 0, '["choice"]', 1, 'CHOICE_ONE', 'EXACT'
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_question_types (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss, normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'english'), 'fill_text', '填空改写', 1, 1, 0, 'text', 1, '["en-spelling"]', 2, 'TEXT_SHORT', 'EXACT'
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_question_types (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss, normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'english'), 'essay', '写作', 0, 0, 1, 'textarea', 0, '[]', 3, 'TEXT_LONG', 'AI_DIMENSION'
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_question_types (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss, normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), 'single_choice', '单项选择', 1, 1, 0, 'choice', 0, '["choice"]', 1, 'CHOICE_ONE', 'EXACT'
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_question_types (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss, normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), 'fill_text', '填空', 1, 1, 0, 'text', 1, '["trim-case"]', 2, 'TEXT_SHORT', 'EXACT'
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_question_types (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss, normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), 'term_explain', '名词解释', 0, 1, 1, 'textarea', 0, '[]', 3, 'TEXT_LONG', 'AI_SCORE_POINTS'
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_question_types (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, ai_review_on_miss, normalizers, sort_order, answer_shape, grading_strategy)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), 'short_answer', '问答', 0, 1, 1, 'textarea', 0, '[]', 4, 'TEXT_LONG', 'AI_SCORE_POINTS'
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');

INSERT OR IGNORE INTO subject_rubrics (subject_id, version, payload, is_current)
SELECT (SELECT subject_id FROM subjects WHERE code = 'english'), 1, '{"grading":{"partialCredit":false,"caseSensitive":false},"essay":{"type":"DIMENSION_WEIGHTED","dimensionMax":6,"totalScore":30,"dimensions":[{"key":"content","name":"内容要点覆盖","weight":0.3,"hint":"是否覆盖题目给出的全部中文写作要点"},{"key":"language","name":"语言准确性","weight":0.25,"hint":"语法、时态、搭配错误的密度"},{"key":"vocabulary","name":"词汇丰富度","weight":0.15,"hint":"用词多样性与准确性"},{"key":"coherence","name":"篇章连贯性","weight":0.2,"hint":"逻辑衔接、段落组织"},{"key":"length","name":"字数达标","weight":0.1,"hint":"100 词左右；低于 70 或高于 150 明显扣分"}]},"mastery":{"masteredMinTotal":3,"masteredMinStreak":3,"weakRateBelow":0.5,"correctThreshold":1.0,"weights":{"untested":2.0,"lastWrong":5.0,"byStreak":[{"upTo":1,"weight":2.0},{"upTo":2,"weight":1.0},{"upTo":null,"weight":0.3}]}},"passLine":60,"fullScore":100}', 1
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_rubrics (subject_id, version, payload, is_current)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), 1, '{"grading":{"partialCredit":true,"caseSensitive":false},"essay":{"type":"POINT_HIT","totalScore":100,"openWeightCap":0.4,"note":"采分点命中式：得分率 = 命中权重 / 总权重。判分实现见 N5。"},"mastery":{"masteredMinTotal":3,"masteredMinStreak":3,"weakRateBelow":0.5,"correctThreshold":1.0,"weights":{"untested":2.0,"lastWrong":5.0,"byStreak":[{"upTo":1,"weight":2.0},{"upTo":2,"weight":1.0},{"upTo":null,"weight":0.3}]}},"passLine":60,"fullScore":100}', 1
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');

INSERT OR IGNORE INTO subject_explanation_schema (subject_id, fields, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'english'), '[{"key":"answerBasis","label":"答案依据","required":true,"widget":"textarea"},{"key":"distractors","label":"干扰项分析","required":false,"widget":"textarea"},{"key":"knowledge","label":"考点归纳","required":true,"widget":"textarea"}]', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_explanation_schema (subject_id, fields, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), '[{"key":"conceptDef","label":"概念界定","required":true,"widget":"textarea"},{"key":"reasoning","label":"推理过程","required":true,"widget":"textarea"},{"key":"scorePoints","label":"采分点拆解","required":true,"widget":"textarea"},{"key":"pitfalls","label":"常见错答","required":false,"widget":"textarea"}]', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');

-- 提示词按学科各写一份。英语这份与蓝本逐字一致：改措辞就是改模型的输出分布，
-- 等于悄悄改了判分，而不会有任何断言变红（验收 A1/A4 要的是英语行为零漂移）。
-- subject_id = 0 是全局兜底，新建学科还没配提示词时不至于整块功能不可用。

INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'english'), 'essay_grade', '你是一位中国自学考试英语科目的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '按下面的评分标准批改这篇自考英语作文。

写作要求：
{{prompt}}

学生作文：
{{essay}}

{{dimensionLines}}

只输出这个 JSON：
{{jsonShape}}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'english'), 'wrong_analyze', '你是一位中国自学考试英语科目的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '分析学生这道题做错的原因。

{{passageBlock}}题干：{{stem}}
{{optionsBlock}}学生答案：{{userAnswer}}
正确答案：{{correctAnswer}}
考点：{{knowledgePoints}}

只输出这个 JSON，两个字段都用中文，各 80 字以内：
{"errorReason":"错在哪、为什么","memoryPoint":"下次遇到同类题该记住什么"}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'english'), 'answer_explain', '你是一位中国自学考试英语科目的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '给学生讲解这道题。

{{passageBlock}}题干：{{stem}}
{{optionsBlock}}学生答案：{{userAnswer}}
正确答案：{{correctAnswer}}
学生{{correctness}}。

只输出这个 JSON，explanation 用中文、200 字以内：
{"explanation":""}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'english'), 'assessment', '你是一位中国自学考试英语科目的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '根据下面这位自考英语考生的数据，给出能力评估。满分 {{fullScore}} 分。

各考点掌握情况：
{{masteryLines}}

最近错题集中的考点：{{recentWrongTags}}
历次模考总分（由旧到新）：{{scoreTrend}}
统计模型给出的预测分：{{predictedScore}}

只输出这个 JSON：
{"predictedLow":0,"predictedHigh":0,"levelDesc":"一句话水平定位",
 "weakPoints":["考点1","考点2"],"suggestions":["建议1","建议2","建议3"]}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');

INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), 'essay_grade', '你是一位生物化学与分子生物学课程的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '按下面的评分标准批改这道生物化学主观题。

写作要求：
{{prompt}}

学生作文：
{{essay}}

{{dimensionLines}}

只输出这个 JSON：
{{jsonShape}}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), 'wrong_analyze', '你是一位生物化学与分子生物学课程的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '分析学生这道题做错的原因。

{{passageBlock}}题干：{{stem}}
{{optionsBlock}}学生答案：{{userAnswer}}
正确答案：{{correctAnswer}}
考点：{{knowledgePoints}}

只输出这个 JSON，两个字段都用中文，各 80 字以内：
{"errorReason":"错在哪、为什么","memoryPoint":"下次遇到同类题该记住什么"}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), 'answer_explain', '你是一位生物化学与分子生物学课程的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '给学生讲解这道题。

{{passageBlock}}题干：{{stem}}
{{optionsBlock}}学生答案：{{userAnswer}}
正确答案：{{correctAnswer}}
学生{{correctness}}。

只输出这个 JSON，explanation 用中文、200 字以内：
{"explanation":""}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT (SELECT subject_id FROM subjects WHERE code = 'biochem'), 'assessment', '你是一位生物化学与分子生物学课程的阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '根据下面这位生物化学与分子生物学考生的数据，给出能力评估。满分 {{fullScore}} 分。

各考点掌握情况：
{{masteryLines}}

最近错题集中的考点：{{recentWrongTags}}
历次模考总分（由旧到新）：{{scoreTrend}}
统计模型给出的预测分：{{predictedScore}}

只输出这个 JSON：
{"predictedLow":0,"predictedHigh":0,"levelDesc":"一句话水平定位",
 "weakPoints":["考点1","考点2"],"suggestions":["建议1","建议2","建议3"]}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');

INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT 0, 'essay_grade', '你是一位阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '按下面的评分标准批改这份作答。

写作要求：
{{prompt}}

学生作文：
{{essay}}

{{dimensionLines}}

只输出这个 JSON：
{{jsonShape}}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT 0, 'wrong_analyze', '你是一位阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '分析学生这道题做错的原因。

{{passageBlock}}题干：{{stem}}
{{optionsBlock}}学生答案：{{userAnswer}}
正确答案：{{correctAnswer}}
考点：{{knowledgePoints}}

只输出这个 JSON，两个字段都用中文，各 80 字以内：
{"errorReason":"错在哪、为什么","memoryPoint":"下次遇到同类题该记住什么"}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT 0, 'answer_explain', '你是一位阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '给学生讲解这道题。

{{passageBlock}}题干：{{stem}}
{{optionsBlock}}学生答案：{{userAnswer}}
正确答案：{{correctAnswer}}
学生{{correctness}}。

只输出这个 JSON，explanation 用中文、200 字以内：
{"explanation":""}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
INSERT OR IGNORE INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
SELECT 0, 'assessment', '你是一位阅卷与辅导老师。回答一律用简体中文，只输出 JSON，不要任何额外文字。', '根据下面这位{{subjectName}}考生的数据，给出能力评估。满分 {{fullScore}} 分。

各考点掌握情况：
{{masteryLines}}

最近错题集中的考点：{{recentWrongTags}}
历次模考总分（由旧到新）：{{scoreTrend}}
统计模型给出的预测分：{{predictedScore}}

只输出这个 JSON：
{"predictedLow":0,"predictedHigh":0,"levelDesc":"一句话水平定位",
 "weakPoints":["考点1","考点2"],"suggestions":["建议1","建议2","建议3"]}', datetime('now')
  WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n3-pack-seed');
-- 门闩落下。放在最后，与上面的写入同属一次导入。
INSERT OR IGNORE INTO seed_state (name, sha) VALUES ('n3-pack-seed', 'v1');
