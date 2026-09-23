-- N4 英语迁入：题型码统一成 fill_text。
--
-- 依据需求文档 §13.1：英语的 fill_blank_transform 改叫 fill_text。生化的内容 JSON
-- 本来就用 fill_text，而 N3 给生化声明的是 fill_blank——两边对不上，N3 那道发布门
-- 会把生化 12 道填空全拒掉（报"题型没在本学科声明过"）。统一成一个名字。
--
-- 为什么要单独一条迁移而不是改 0009 的种子：0009 的种子上了门闩
-- （n3-pack-seed），线上不会再插一遍，改种子对已经落库的行毫无作用。
-- 门闩防的是"被删掉的配置又被插回来"，代价就是改不动已有的行——
-- 要改就得像这样显式写一条 UPDATE，并且给它自己的门闩。
--
-- questions.question_type 那边不用在这里改：题面 JSON 里的题型名也一起改了，
-- 种子的内容指纹会变，流水线会整批重新导入。

UPDATE subject_question_types
   SET type_code = 'fill_text'
 WHERE type_code IN ('fill_blank_transform', 'fill_blank')
   AND NOT EXISTS (SELECT 1 FROM seed_state WHERE name = 'n4-fill-text-rename');

INSERT OR IGNORE INTO seed_state (name, sha) VALUES ('n4-fill-text-rename', 'v1');
