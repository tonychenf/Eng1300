// 学科作用域下的用户端接口：/api/s/:subjectCode/*
//
// 本期（N1）只放学科自身的元信息与课程列表。模考、练习、错题本这些既有接口
// 仍挂在老路径上，等后续里程碑逐个搬进来——一次全搬会把蓝本的 240 条断言
// 同时弄红，分不清是搬迁出的问题还是学科层出的问题。
import { Hono } from 'hono';
import { requireAuth } from '../lib/auth.js';
import { resolveSubject } from '../lib/subject.js';

export const subjectRouter = new Hono();

subjectRouter.use('/s/:subjectCode/*', requireAuth, resolveSubject);
subjectRouter.use('/s/:subjectCode', requireAuth, resolveSubject);

function publicShape(s) {
  return {
    code: s.code,
    name: s.name,
    description: s.description,
    contentGroupKind: s.content_group_kind,
    sortOrder: s.sort_order,
  };
}

// 学科详情：进入学科后前端拿它建 SubjectContext
subjectRouter.get('/s/:subjectCode', async (c) => {
  const s = c.get('subject');
  const stat = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM courses WHERE subject_id = ?1) AS course_count,
       (SELECT COUNT(*) FROM exams e JOIN courses co ON co.course_code = e.course_code
         WHERE co.subject_id = ?1 AND e.status = '已发布') AS published_groups,
       (SELECT COUNT(*) FROM questions q JOIN courses co ON co.course_code = q.course_code
         WHERE co.subject_id = ?1 AND q.status = '已发布') AS published_questions`
  ).bind(s.subject_id).first();

  return c.json({
    subject: {
      ...publicShape(s),
      courseCount: stat.course_count,
      publishedGroups: stat.published_groups,
      publishedQuestions: stat.published_questions,
      // 题库还没铺开的学科，前端据此显示"尚未开放内容"而不是让人点进去扑空
      ready: stat.published_questions > 0,
    },
  });
});

// 该学科下的课程
subjectRouter.get('/s/:subjectCode/courses', async (c) => {
  const s = c.get('subject');
  const { results } = await c.env.DB.prepare(
    `SELECT co.course_code, co.course_name, co.time_limit_minutes, co.total_score,
            (SELECT COUNT(*) FROM exams e
              WHERE e.course_code = co.course_code AND e.status = '已发布') AS published_exams,
            (SELECT COUNT(*) FROM questions q
              WHERE q.course_code = co.course_code AND q.status = '已发布') AS published_questions
       FROM courses co
      WHERE co.subject_id = ?
      ORDER BY co.course_code`
  ).bind(s.subject_id).all();
  return c.json({ courses: results });
});
