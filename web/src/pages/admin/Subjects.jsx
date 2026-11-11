import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, patch } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

export default function Subjects() {
  const [subjects, setSubjects] = useState(null);
  const [error, setError] = useState('');
  const [lists, setLists] = useState({});   // 学科码 → 上线清单

  const load = () => Promise.all([get('/admin/subjects'), get('/admin/checklists')])
    .then(([r, c]) => {
      setSubjects(r.subjects);
      setLists(Object.fromEntries((c.checklists || []).map((x) => [x.subject.code, x])));
    })
    .catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  // 改课程的满分、时长（P1-A4）。只影响以后组的卷；模板总分对不上时提示去改模板
  async function editCourse(s, cl) {
    const c = cl?.course;
    if (!c) return;
    const total = prompt(`「${s.name}」的满分（1–1000）`, String(c.totalScore));
    if (total === null) return;
    const mins = prompt(`「${s.name}」的考试时长（分钟，10–600）`, String(c.timeLimitMinutes));
    if (mins === null) return;
    setError('');
    try {
      const r = await patch(`/admin/courses/${c.courseCode}`, { totalScore: Number(total), timeLimitMinutes: Number(mins) });
      if (r.templateMismatch) {
        alert(`组卷模板加起来是 ${r.templateMismatch.total} 分，和满分 ${r.templateMismatch.expected} 对不上，学员暂时组不了卷。去「组卷模板」改一下。`);
      }
      await load();
    } catch (err) { setError(err.message); }
  }

  async function toggle(s) {
    const next = s.status === '启用' ? '停用' : '启用';
    if (next === '停用' && !confirm(
      `确认停用「${s.name}」？\n\n停用后学员侧不可见、不能进入，但已有数据全部保留，随时可以再启用。\n正在答题的学员仍然可以正常交卷。`
    )) return;
    setError('');
    try {
      await patch(`/admin/subjects/${s.subject_id}`, { status: next });
      await load();
    } catch (err) { setError(err.message); }
  }

  async function rename(s) {
    const name = prompt('学科名称', s.name);
    if (name === null || name.trim() === s.name) return;
    setError('');
    try {
      await patch(`/admin/subjects/${s.subject_id}`, { name: name.trim() });
      await load();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <PageHead title="学科管理" desc="学科是平台的顶层分区：题库、考点、评价标准、报告都按学科隔离"
        actions={<Link className="btn" to="/admin/subjects/new" data-testid="new-subject">开一门新课</Link>} />
      {error ? <Alert>{error}</Alert> : null}

      {!subjects ? <Loading /> : (
        <div className="grid-cards">
          {subjects.map((s) => (
            <div className="card card-pad" key={s.subject_id}>
              <div className="spread" style={{ marginBottom: 8 }}>
                <h2 style={{ fontSize: 16 }}>{s.name}</h2>
                <span className={`badge${s.status === '启用' ? ' info' : ''}`}>{s.status}</span>
              </div>
              <p className="tiny faint" style={{ marginTop: 0 }}>
                {s.code} · {s.content_group_kind === 'TEXTBOOK_CHAPTER' ? '按章节' : '按试卷'}
              </p>
              {s.description ? <p className="small muted">{s.description}</p> : null}
              <p className="small">
                课程 <strong>{s.course_count}</strong> 门 ·
                题目 <strong>{s.question_count}</strong> 道（可抽 <strong>{s.published_questions}</strong>）·
                已开通 <strong>{s.member_count}</strong> 人
              </p>
              {lists[s.code] ? (
                <p className="tiny" data-testid="checklist-summary">
                  <span className={`badge ${lists[s.code].state === 'ready' ? 'ok' : lists[s.code].state === 'practice_only' ? 'warn' : 'gray'}`}
                    style={{ marginRight: 6 }}>
                    {{ ready: '已就绪', practice_only: '能练习', not_usable: '还不能用' }[lists[s.code].state]}
                  </span>
                  {lists[s.code].summary.replace(`${s.name}：`, '')}
                </p>
              ) : null}
              {lists[s.code]?.course ? (
                <p className="tiny muted">
                  满分 {lists[s.code].course.totalScore} 分 · {lists[s.code].course.timeLimitMinutes} 分钟
                  <button className="btn ghost sm" style={{ marginLeft: 6 }} onClick={() => editCourse(s, lists[s.code])}>改</button>
                </p>
              ) : null}
              <div className="row" style={{ marginTop: 12, flexWrap: 'wrap' }}>
                <Link className="btn sm" to={`/admin/subjects/${s.subject_id}/setup`}>上线清单</Link>
                <Link className="btn ghost sm" to={`/admin/subjects/${s.subject_id}/template`}>组卷模板</Link>
                <Link className="btn ghost sm" to={`/admin/subjects/${s.subject_id}/members`}>成员</Link>
                <Link className="btn ghost sm" to={`/admin/subjects/${s.subject_id}/pack`}>能力包</Link>
                <Link className="btn ghost sm" to={`/admin/subjects/${s.subject_id}/knowledge-points`} data-testid="subject-kp-link">考点整理</Link>
                <button className="btn ghost sm" onClick={() => rename(s)}>改名</button>
                <button className="btn ghost sm" onClick={() => toggle(s)}>
                  {s.status === '启用' ? '停用' : '启用'}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <p className="small muted" style={{ marginTop: 24 }}>
        学科不支持删除。一旦有作答数据，删除会让历史报告的口径断裂——需要下线时请用「停用」。
      </p>
    </>
  );
}
