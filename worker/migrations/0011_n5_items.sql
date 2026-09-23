-- N5 得分单元与结构化组卷模板。
-- 依据需求文档 §6.4.5（得分单元）、§6.4.7（分值归属）、§6.4.8（组卷模板）。

-- ---------- 得分单元 ----------
-- 一题多空与主观题采分点是同一件事：都是"题目的一个子项，自带权重，自带一个
-- 命中/未命中的判定"。v2 为它们建了两张表，照那条路走下去多选题的部分分会逼出
-- 第三张、计算题的步骤分会逼出第四张。合并成一张之后，判分骨架只有一个循环。
--
-- **单元素退化**：单空填空、单选题不建单元，直接用 questions.answer。
-- 英语的现有路径因此一个字符都不变——这条约束不能破。
CREATE TABLE IF NOT EXISTS question_items (
  question_id TEXT NOT NULL REFERENCES questions(question_id),
  item_ord INTEGER NOT NULL,
  subject_id INTEGER REFERENCES subjects(subject_id),
  -- BLANK 填空的空 / SCORE_POINT 采分点 / OPTION 多选的选项 / STEP 解答步骤
  item_kind TEXT NOT NULL,
  -- 覆盖题型上的默认策略；为空则用题型声明的那个
  grading_strategy TEXT,
  -- 同 group_key 的单元共同判定（无序并列空、一组必须同时命中的采分点）
  group_key TEXT,
  answer TEXT,                       -- SCORE_POINT 时是要点描述
  alt_answers TEXT,                  -- JSON 数组，归一化器之外的显式别名
  -- **相对权重，不是绝对分值**（§6.4.7）。题目满分由组卷模板赋予。
  weight REAL NOT NULL DEFAULT 1,
  -- JSON：容差、单位、枚举、候选池等策略专用参数；
  -- 另含 dependsOn（步骤依赖）与 openEnded（开放采分点）
  params TEXT,
  PRIMARY KEY (question_id, item_ord)
);
CREATE INDEX IF NOT EXISTS idx_qitems_subject ON question_items(subject_id);

-- ---------- 结构化组卷模板 ----------
-- 蓝本的 exam_templates 只能按题型组卷（course_code, ord, section_type, ...）。
-- 生化要按章节配比，按考点、按难度同样表达不了。改成结构化筛选器。
--
-- 不删 exam_templates：英语的现有组卷路径还在用它，两者并存到 N7 接口搬迁时再收。
-- 并存期间以 exam_template_items 为准——planPaper 有它就用它。
CREATE TABLE IF NOT EXISTS exam_template_items (
  course_code TEXT NOT NULL REFERENCES courses(course_code),
  ord INTEGER NOT NULL,
  label TEXT NOT NULL,
  -- JSON：{ questionTypes?, sectionTypes?, knowledgePoints?, chapterNos?, difficulty? }
  -- 多条件取交集。英语迁入时只填 sectionTypes，行为与现状完全一致。
  filter TEXT NOT NULL DEFAULT '{}',
  question_count INTEGER NOT NULL,
  -- FROM_TEMPLATE：分值由模板给（默认）；FROM_QUESTION：题目自带绝对分值
  score_mode TEXT NOT NULL DEFAULT 'FROM_TEMPLATE'
    CHECK (score_mode IN ('FROM_TEMPLATE', 'FROM_QUESTION')),
  score_per_question REAL,
  -- 抽题单位下放到模板项：一个学科完全可能混用（材料题整组抽、填空题单题抽），
  -- 放在学科上表达不了
  pick_unit TEXT NOT NULL DEFAULT 'SECTION'
    CHECK (pick_unit IN ('SECTION', 'QUESTION')),
  PRIMARY KEY (course_code, ord)
);

-- 英语两门课程的模板照搬现状迁入：filter 只填 section_types，pick_unit=SECTION，
-- score_mode=FROM_TEMPLATE。**行为必须与 exam_templates 完全一致**，
-- 所以直接从那张表生成，不手抄一遍——手抄会抄错，而抄错了组卷照跑不报错。
INSERT OR IGNORE INTO exam_template_items
  (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
SELECT t.course_code, t.ord, t.section_type,
       '{"sectionTypes":["' || replace(t.section_type, '"', '""') || '"]}',
       t.question_count, 'FROM_TEMPLATE', t.score_per_question, 'SECTION'
  FROM exam_templates t
 WHERE NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n5-template-migrate');

INSERT OR IGNORE INTO seed_state (name, sha) VALUES ('n5-template-migrate', 'v1');
