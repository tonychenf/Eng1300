import { useEffect, useState } from 'react';
import { get, patch, post } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

const KINDS = [
  { value: 'EXAM_PAPER', label: '年份试卷（如历年真题）' },
  { value: 'TEXTBOOK_CHAPTER', label: '教材章节（如按章推进的课程）' },
];

export default function Subjects() {
  const [subjects, setSubjects] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ code: '', name: '', description: '', contentGroupKind: 'EXAM_PAPER' });

  const load = () => get('/admin/subjects').then((r) => setSubjects(r.subjects)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setError('');
    try {
      await post('/admin/subjects', {
        code: form.code.trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        contentGroupKind: form.contentGroupKind,
        sortOrder: (subjects?.length ?? 0) + 1,
      });
      setForm({ code: '', name: '', description: '', contentGroupKind: 'EXAM_PAPER' });
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
      <PageHead title="学科管理" desc="学科是平台的顶层分区：题库、考点、评价标准、报告都按学科隔离" />
      {error ? <Alert>{error}</Alert> : null}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>新建学科</h2>
        <form onSubmit={create} className="stack">
          <label className="small">
            学科码
            <input
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
              placeholder="如 history，2-20 位小写字母开头"
              required
            />
            <span className="tiny faint">建科后不可修改：它会进 URL、进导出文件名、进种子文件名。</span>
          </label>
          <label className="small">
            学科名称
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required />
          </label>
          <label className="small">
            简介
            <input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
          </label>
          <label className="small">
            内容组织维度
            <select
              value={form.contentGroupKind}
              onChange={(e) => setForm({ ...form, contentGroupKind: e.target.value })}
            >
              {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
            <span className="tiny faint">建科后不可修改：改了会让已有内容组的排序语义断裂。</span>
          </label>
          <div><button className="btn sm" type="submit">创建</button></div>
        </form>
      </div>

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
                内容组 <strong>{s.group_count}</strong> 个 ·
                题目 <strong>{s.question_count}</strong> 道（可抽 <strong>{s.published_questions}</strong>）
              </p>
              <div className="row" style={{ marginTop: 12 }}>
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
