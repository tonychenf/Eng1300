// 考点整理（改进阶段 2 第三期 F，PRD 7.3）。挂在 /api/admin/subjects 下：
//
//   GET   /:id/knowledge-points          这个学科的全部考点：名字、上级、挂了几道题、几条学员掌握度记录、几个下级、是不是 AI 建的、模板里有没有用到
//   PATCH /:id/knowledge-points/:tagId   改名、调上级（只能挂到本学科的一级考点下）
//   POST  /:id/knowledge-points/merge    合并 A → B：一个 batch，A 的题、掌握度、下级、模板筛选、专项练习的范围都转给 B，删掉 A
//
// 不做删除（BRD 第 7 节）：没用的考点合并进别的，数据不丢。
import { Hono } from 'hono';
import { auditStmt } from '../lib/audit.js';

export const kpRouter = new Hono();
const bad = (c, status, error, message, extra = {}) => c.json({ error, message, ...extra }, status);
export const KP_NAME_LIMIT = 40;

async function loadSubject(c) {
  const id = Number(c.req.param('id'));
  if (!Number.isInteger(id)) return null;
  return c.env.DB.prepare('SELECT subject_id, code, name FROM subjects WHERE subject_id = ?').bind(id).first();
}

/** 这个学科各课程的组卷模板项里，筛选器用到了哪些考点：{ tagId: [{ courseCode, ord, label }] } */
async function templateRefs(db, subjectId) {
  const { results } = await db.prepare(
    `SELECT t.course_code, t.ord, t.label, t.filter FROM exam_template_items t
       JOIN courses co ON co.course_code = t.course_code WHERE co.subject_id = ?`
  ).bind(subjectId).all();
  const refs = {};
  const items = [];
  for (const r of results) {
    let f = {};
    try { f = JSON.parse(r.filter || '{}') || {}; } catch { continue; }   // 读不懂的筛选器组卷时自己会报，这里不替它判
    items.push({ ...r, parsed: f });
    for (const t of Array.isArray(f.knowledgePoints) ? f.knowledgePoints : []) {
      (refs[t] ||= []).push({ courseCode: r.course_code, ord: r.ord, label: r.label });
    }
  }
  return { refs, items };
}

kpRouter.get('/:id/knowledge-points', async (c) => {
  const db = c.env.DB;
  const subject = await loadSubject(c);
  if (!subject) return bad(c, 404, 'not_found', '没有这个学科');
  const { results } = await db.prepare(
    `SELECT k.tag_id, k.name, k.parent_tag_id, k.sort_order,
            (SELECT COUNT(*) FROM question_knowledge_points x WHERE x.tag_id = k.tag_id) AS questions,
            (SELECT COUNT(*) FROM user_knowledge_mastery m WHERE m.tag_id = k.tag_id) AS mastery,
            (SELECT COUNT(*) FROM knowledge_points ch WHERE ch.parent_tag_id = k.tag_id) AS children
       FROM knowledge_points k WHERE k.subject_id = ? ORDER BY k.sort_order, k.name`
  ).bind(subject.subject_id).all();
  const { refs } = await templateRefs(db, subject.subject_id);
  const nameOf = new Map(results.map((r) => [r.tag_id, r.name]));
  return c.json({
    subject: { id: subject.subject_id, code: subject.code, name: subject.name },
    knowledgePoints: results.map((r) => ({
      tagId: r.tag_id, name: r.name, parentTagId: r.parent_tag_id, parentName: r.parent_tag_id ? nameOf.get(r.parent_tag_id) ?? null : null,
      questions: r.questions, mastery: r.mastery, children: r.children,
      aiCreated: String(r.tag_id).startsWith('kp-ai-'), templates: refs[r.tag_id] || [],
    })),
  });
});

kpRouter.patch('/:id/knowledge-points/:tagId', async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const subject = await loadSubject(c);
  if (!subject) return bad(c, 404, 'not_found', '没有这个学科');
  const kp = await db.prepare('SELECT * FROM knowledge_points WHERE tag_id = ? AND subject_id = ?')
    .bind(c.req.param('tagId'), subject.subject_id).first();
  if (!kp) return bad(c, 404, 'not_found', '这个学科里没有这个考点');
  const body = await c.req.json().catch(() => ({}));
  const sets = [];
  const binds = [];
  const after = {};

  if ('name' in body) {
    const name = String(body.name ?? '').trim();
    if (!name) return bad(c, 400, 'invalid_name', '考点名不能是空的');
    if ([...name].length > KP_NAME_LIMIT) return bad(c, 400, 'invalid_name', `考点名最多 ${KP_NAME_LIMIT} 个字`);
    if (name !== kp.name) {
      const dup = await db.prepare('SELECT tag_id FROM knowledge_points WHERE subject_id = ? AND name = ? AND tag_id <> ?')
        .bind(subject.subject_id, name, kp.tag_id).first();
      // 同学科不重名（库里有唯一约束；这里先查一遍，好说清是哪个重了、要不要改成合并）
      if (dup) return bad(c, 409, 'name_taken', `「${name}」这个考点已经有了；两个是同一回事的话，用「合并」`, { tagId: dup.tag_id });
      sets.push('name = ?'); binds.push(name); after.name = name;
    }
  }
  if ('parentTagId' in body) {
    const parent = body.parentTagId == null || body.parentTagId === '' ? null : String(body.parentTagId);
    if (parent === kp.tag_id) return bad(c, 422, 'bad_parent', '不能挂到自己下面');
    if (parent) {
      const p = await db.prepare('SELECT tag_id, parent_tag_id FROM knowledge_points WHERE tag_id = ? AND subject_id = ?')
        .bind(parent, subject.subject_id).first();
      if (!p) return bad(c, 422, 'bad_parent', '上级要是这个学科里的考点');
      // 只能挂到一级考点下：挂到二级下面就是三级；自己的下级都是二级，这一条也把"挂到自己的下级"挡住了
      if (p.parent_tag_id) return bad(c, 422, 'bad_parent', '上级只能是一级考点（它本身没有上级的那种）');
      const kids = await db.prepare('SELECT COUNT(*) AS n FROM knowledge_points WHERE parent_tag_id = ?').bind(kp.tag_id).first();
      if (kids.n > 0) return bad(c, 422, 'has_children', `它下面还挂着 ${kids.n} 个考点，挂到别人下面就成了三级；先把下级挪走`);
    }
    if (parent !== kp.parent_tag_id) { sets.push('parent_tag_id = ?'); binds.push(parent); after.parentTagId = parent; }
  }
  if (!sets.length) return c.json({ ok: true, changed: [] });
  await db.batch([
    db.prepare(`UPDATE knowledge_points SET ${sets.join(', ')} WHERE tag_id = ?`).bind(...binds, kp.tag_id),
    auditStmt(db, { actorId: me.id, action: 'kp.update', subjectId: subject.subject_id, target: kp.tag_id,
      before: { name: kp.name, parentTagId: kp.parent_tag_id }, after }),
  ]);
  return c.json({ ok: true, changed: Object.keys(after) });
});

/** 掌握度合并时取 A 那一行的某一列（同一学员同一课程）；占位符的值记进 binds，免得数错 */
const aColOf = (binds, fromId) => (col) => {
  binds.push(fromId);
  return `(SELECT a.${col} FROM user_knowledge_mastery a
   WHERE a.user_id = user_knowledge_mastery.user_id AND a.course_code = user_knowledge_mastery.course_code AND a.tag_id = ?)`;
};

kpRouter.post('/:id/knowledge-points/merge', async (c) => {
  const db = c.env.DB;
  const me = c.get('user');
  const subject = await loadSubject(c);
  if (!subject) return bad(c, 404, 'not_found', '没有这个学科');
  const body = await c.req.json().catch(() => ({}));
  const fromId = String(body.from ?? '');
  const intoId = String(body.into ?? '');
  if (!fromId || !intoId) return bad(c, 400, 'invalid_request', '要给出把哪个（from）合并进哪个（into）');
  if (fromId === intoId) return bad(c, 422, 'same_kp', '不能合并进自己');
  const pick = (id) => db.prepare('SELECT * FROM knowledge_points WHERE tag_id = ? AND subject_id = ?').bind(id, subject.subject_id).first();
  const [A, B] = [await pick(fromId), await pick(intoId)];
  if (!A || !B) return bad(c, 404, 'not_found', `这个学科里没有考点 ${!A ? fromId : intoId}`);

  // B 原来挂在 A 下面：A 没了，B 接替 A 的位置（挂到 A 的上级）
  const bParent = B.parent_tag_id === A.tag_id ? A.parent_tag_id : B.parent_tag_id;
  const { results: kids } = await db.prepare('SELECT tag_id, name FROM knowledge_points WHERE parent_tag_id = ?').bind(A.tag_id).all();
  const movedKids = kids.filter((k) => k.tag_id !== B.tag_id);
  if (movedKids.length && bParent) {
    return bad(c, 422, 'would_nest',
      `「${A.name}」下面有 ${movedKids.length} 个考点，要转给「${B.name}」；可「${B.name}」本身是二级考点，转过去就成了三级。先把下级挪走，或者反过来合并`);
  }

  // 合并前 A 的全部数据，存进合并记录和审计，好追查
  const { results: qs } = await db.prepare('SELECT question_id FROM question_knowledge_points WHERE tag_id = ? ORDER BY question_id').bind(A.tag_id).all();
  const { results: mastery } = await db.prepare('SELECT * FROM user_knowledge_mastery WHERE tag_id = ? ORDER BY user_id, course_code').bind(A.tag_id).all();
  const { refs, items } = await templateRefs(db, subject.subject_id);
  const snapshot = {
    kp: A, questions: qs.map((r) => r.question_id), mastery, children: kids.map((k) => k.tag_id), templates: refs[A.tag_id] || [],
  };

  const mBinds = [];
  const aCol = aColOf(mBinds, A.tag_id);
  const st = [
    // 1. 掌握度：同一学员同一课程两边都有的，次数相加；连对和上次结果取最近练过的那一行；最近练习时间取较晚的。
    //    SET 里读到的都是这一行改之前的值，所以条件里的 last_practiced_at 是 B 原来的
    db.prepare(
      `UPDATE user_knowledge_mastery SET
         correct_count = correct_count + ${aCol('correct_count')},
         wrong_count = wrong_count + ${aCol('wrong_count')},
         consecutive_correct = CASE WHEN IFNULL(${aCol('last_practiced_at')}, '') > IFNULL(last_practiced_at, '')
                                    THEN ${aCol('consecutive_correct')} ELSE consecutive_correct END,
         last_result = CASE WHEN IFNULL(${aCol('last_practiced_at')}, '') > IFNULL(last_practiced_at, '')
                            THEN ${aCol('last_result')} ELSE last_result END,
         last_practiced_at = NULLIF(MAX(IFNULL(last_practiced_at, ''), IFNULL(${aCol('last_practiced_at')}, '')), '')
       WHERE tag_id = ? AND EXISTS (SELECT 1 FROM user_knowledge_mastery a
         WHERE a.user_id = user_knowledge_mastery.user_id AND a.course_code = user_knowledge_mastery.course_code AND a.tag_id = ?)`
    ).bind(...mBinds, B.tag_id, A.tag_id),
    //    只有 A 有的：整行改挂 B（排在上一句之后——先插的话，上一句会把刚插的行再加一遍）
    db.prepare(
      `INSERT INTO user_knowledge_mastery (user_id, course_code, tag_id, correct_count, wrong_count, consecutive_correct, last_result, last_practiced_at)
       SELECT a.user_id, a.course_code, ?, a.correct_count, a.wrong_count, a.consecutive_correct, a.last_result, a.last_practiced_at
         FROM user_knowledge_mastery a WHERE a.tag_id = ? AND NOT EXISTS (SELECT 1 FROM user_knowledge_mastery b
           WHERE b.user_id = a.user_id AND b.course_code = a.course_code AND b.tag_id = ?)`
    ).bind(B.tag_id, A.tag_id, B.tag_id),
    db.prepare('DELETE FROM user_knowledge_mastery WHERE tag_id = ?').bind(A.tag_id),
    // 2. 题：A 改成 B，已经同时挂着 B 的去重
    db.prepare('INSERT OR IGNORE INTO question_knowledge_points (question_id, tag_id) SELECT question_id, ? FROM question_knowledge_points WHERE tag_id = ?')
      .bind(B.tag_id, A.tag_id),
    db.prepare('DELETE FROM question_knowledge_points WHERE tag_id = ?').bind(A.tag_id),
    // 3. 上下级：B 原来挂在 A 下的先挪到 A 的上级，A 别的下级改挂 B
    db.prepare('UPDATE knowledge_points SET parent_tag_id = ? WHERE tag_id = ? AND parent_tag_id = ?').bind(A.parent_tag_id, B.tag_id, A.tag_id),
    db.prepare('UPDATE knowledge_points SET parent_tag_id = ? WHERE parent_tag_id = ? AND tag_id <> ?').bind(B.tag_id, A.tag_id, B.tag_id),
    // 4. 单考点专项练习的范围（没有外键，不改的话进行中的专项一道题都抽不到）
    db.prepare('UPDATE attempts SET scope_knowledge_point = ? WHERE scope_knowledge_point = ?').bind(B.tag_id, A.tag_id),
  ];
  // 5. 组卷模板的筛选器里写着 A 的，换成 B（去重），模板版本号加一——开着模板页的人再保存会被告知模板变了
  const courses = new Set();
  for (const it of items) {
    const list = Array.isArray(it.parsed.knowledgePoints) ? it.parsed.knowledgePoints : [];
    if (!list.includes(A.tag_id)) continue;
    const next = { ...it.parsed, knowledgePoints: [...new Set(list.map((t) => (t === A.tag_id ? B.tag_id : t)))] };
    st.push(db.prepare('UPDATE exam_template_items SET filter = ? WHERE course_code = ? AND ord = ?').bind(JSON.stringify(next), it.course_code, it.ord));
    courses.add(it.course_code);
  }
  for (const co of courses) st.push(db.prepare('UPDATE courses SET template_version = template_version + 1 WHERE course_code = ?').bind(co));
  const who = me?.username || `user:${me?.id ?? '?'}`;
  st.push(
    // 6. 合并记录：以前合并进 A 的跟着改成 B（连着合并时永远指向一个还在的考点），再记 A → B
    db.prepare('UPDATE knowledge_point_merges SET into_tag_id = ? WHERE into_tag_id = ?').bind(B.tag_id, A.tag_id),
    db.prepare(
      `INSERT OR REPLACE INTO knowledge_point_merges (from_tag_id, from_name, subject_id, into_tag_id, snapshot_json, merged_by) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(A.tag_id, A.name, subject.subject_id, B.tag_id, JSON.stringify(snapshot), who),
    db.prepare('DELETE FROM knowledge_points WHERE tag_id = ?').bind(A.tag_id),
    auditStmt(db, { actorId: me.id, action: 'kp.merge', subjectId: subject.subject_id, target: A.tag_id,
      before: snapshot, after: { into: B.tag_id, intoName: B.name } }),
  );
  await db.batch(st);
  return c.json({
    ok: true, from: { tagId: A.tag_id, name: A.name }, into: { tagId: B.tag_id, name: B.name },
    moved: { questions: qs.length, mastery: mastery.length, children: movedKids.length, templateItems: (refs[A.tag_id] || []).length },
  });
});
