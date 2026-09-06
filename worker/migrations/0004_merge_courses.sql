-- 课程合并：00015《英语(二)》与 13000《英语(专升本)》是同一门课的前后两个代码
-- （2024 年 10 月起启用新代码，考试结构、时长、分值完全一致）。
-- 统一归到 13000，组卷与练习从此面对一个完整题库。
-- 顺序：先改引用，再删模板，最后删课程行，避免外键报错。

UPDATE courses SET course_name = '英语(二)/英语(专升本)' WHERE course_code = '13000';

UPDATE exams     SET course_code = '13000' WHERE course_code = '00015';
UPDATE questions SET course_code = '13000' WHERE course_code = '00015';

DELETE FROM exam_templates WHERE course_code = '00015';
DELETE FROM courses        WHERE course_code = '00015';
