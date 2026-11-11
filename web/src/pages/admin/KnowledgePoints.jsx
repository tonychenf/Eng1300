import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, patch, post } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

// 考点整理（改进阶段 2 第三期 F，PRD 7.3）：/admin/subjects/:id/knowledge-points
//   一级考点下面列二级；每个考点：挂了几道题、几条学员掌握度记录、是不是 AI 建的、组卷模板里有没有用到。
//   改名、调上级（只能挂到一级考点下）、合并到另一个（题、掌握度、下级、模板筛选都转过去，删掉这一个）。不做删除。

export default function KnowledgePoints() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(null);   // { tagId, mode: 'rename' | 'parent' | 'merge' }
  const [q, setQ] = useState('');

  const load = () => get(`/admin/subjects/${id}/knowledge-points`).then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  async function act(fn, done) {
    setError(''); setBusy(true);
    try { const r = await fn(); setMsg(done(r)); setOpen(null); await load(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  const kps = data.knowledgePoints;
  const tops = kps.filter((k) => !k.parentTagId);
  const childrenOf = (t) => kps.filter((k) => k.parentTagId === t);
  const match = (k) => !q.trim() || k.name.includes(q.trim());
  const shown = tops.filter((t) => match(t) || childrenOf(t.tagId).some(match));

  const row = (k, level) => (
    <div key={k.tagId} className={`kp-row${level ? ' kp-child' : ''}`} data-testid="kp-row" data-tag={k.tagId}>
      <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
        <div>
          <strong data-testid="kp-name">{k.name}</strong>
          {k.aiCreated ? <span className="badge gray" style={{ marginLeft: 6 }}>AI 建的</span> : null}
          <div className="tiny muted" data-testid="kp-counts">
            {k.questions} 道题 · {k.mastery} 条学员记录{k.children ? ` · ${k.children} 个下级` : ''}{k.templates.length ? ` · 组卷模板用到 ${k.templates.length} 处` : ''}
          </div>
        </div>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn ghost sm" data-testid="kp-rename" onClick={() => setOpen({ tagId: k.tagId, mode: 'rename' })}>改名</button>
          <button className="btn ghost sm" data-testid="kp-parent" onClick={() => setOpen({ tagId: k.tagId, mode: 'parent' })}>上级</button>
          <button className="btn ghost sm" data-testid="kp-merge" onClick={() => setOpen({ tagId: k.tagId, mode: 'merge' })}>合并到…</button>
        </span>
      </div>
      {open?.tagId === k.tagId ? <Editor k={k} mode={open.mode} kps={kps} busy={busy} onCancel={() => setOpen(null)} act={act} subjectId={id} /> : null}
    </div>
  );

  return (
    <>
      <PageHead title="考点整理" desc={data.subject.name} />
      <p className="small"><Link to="/admin/subjects">← 回到学科管理</Link></p>
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {msg ? <div style={{ marginBottom: 12 }}><Alert kind="success">{msg}</Alert></div> : null}
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
          <span className="small" data-testid="kp-total">共 {kps.length} 个考点（一级 {tops.length} 个）</span>
          <input className="input" style={{ maxWidth: 260 }} placeholder="按名字找" value={q} onChange={(e) => setQ(e.target.value)} aria-label="按名字找考点" />
        </div>
        <p className="tiny muted" style={{ margin: '8px 0 0' }}>不能删除：没用的、重复的考点「合并到」另一个，题和学员的掌握度都转过去。</p>
      </div>
      {shown.length ? shown.map((t) => (
        <div key={t.tagId} className="card card-pad stack" style={{ marginBottom: 10 }}>
          {row(t, 0)}
          {childrenOf(t.tagId).filter((k) => match(k) || match(t)).map((k) => row(k, 1))}
        </div>
      )) : <div className="card card-pad small">没有找到考点。</div>}
    </>
  );
}

function Editor({ k, mode, kps, busy, onCancel, act, subjectId }) {
  const [name, setName] = useState(k.name);
  const [parent, setParent] = useState(k.parentTagId || '');
  const [into, setInto] = useState('');
  const base = `/admin/subjects/${subjectId}/knowledge-points`;
  const tops = kps.filter((x) => !x.parentTagId && x.tagId !== k.tagId);
  const others = kps.filter((x) => x.tagId !== k.tagId);
  const label = (x) => (x.parentName ? `${x.parentName} / ${x.name}` : x.name);
  return (
    <div className="kp-editor stack" data-testid="kp-editor">
      {mode === 'rename' ? (
        <>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} aria-label="新名字" data-testid="kp-name-input" />
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" disabled={busy || !name.trim()} data-testid="kp-save"
              onClick={() => act(() => patch(`${base}/${encodeURIComponent(k.tagId)}`, { name }), () => `改成了「${name.trim()}」`)}>保存</button>
            <button className="btn ghost sm" onClick={onCancel}>取消</button>
          </div>
        </>
      ) : null}
      {mode === 'parent' ? (
        <>
          <select className="input" value={parent} onChange={(e) => setParent(e.target.value)} aria-label="上级" data-testid="kp-parent-select">
            <option value="">（没有上级：一级考点）</option>
            {tops.map((x) => <option key={x.tagId} value={x.tagId}>{x.name}</option>)}
          </select>
          {k.children ? <p className="tiny muted" style={{ margin: 0 }}>它下面有 {k.children} 个考点，只能当一级考点。</p> : null}
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" disabled={busy} data-testid="kp-save"
              onClick={() => act(() => patch(`${base}/${encodeURIComponent(k.tagId)}`, { parentTagId: parent || null }),
                () => `「${k.name}」${parent ? `挂到了「${tops.find((x) => x.tagId === parent)?.name}」下面` : '改成了一级考点'}`)}>保存</button>
            <button className="btn ghost sm" onClick={onCancel}>取消</button>
          </div>
        </>
      ) : null}
      {mode === 'merge' ? (
        <>
          <select className="input" value={into} onChange={(e) => setInto(e.target.value)} aria-label="合并到" data-testid="kp-into-select">
            <option value="">选一个考点…</option>
            {others.map((x) => <option key={x.tagId} value={x.tagId}>{label(x)}</option>)}
          </select>
          <p className="tiny muted" style={{ margin: 0 }}>
            「{k.name}」的 {k.questions} 道题、{k.mastery} 条学员记录{k.children ? `、${k.children} 个下级` : ''}{k.templates.length ? `、组卷模板里的 ${k.templates.length} 处` : ''}都转过去，然后删掉「{k.name}」。撤不回。
          </p>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn danger sm" disabled={busy || !into} data-testid="kp-merge-go"
              onClick={() => {
                const target = others.find((x) => x.tagId === into);
                if (!confirm(`把「${k.name}」合并到「${target?.name}」？撤不回。`)) return;
                act(() => post(`${base}/merge`, { from: k.tagId, into }),
                  (r) => `「${r.from.name}」合并进了「${r.into.name}」：转过去 ${r.moved.questions} 道题、${r.moved.mastery} 条学员记录`);
              }}>合并</button>
            <button className="btn ghost sm" onClick={onCancel}>取消</button>
          </div>
        </>
      ) : null}
    </div>
  );
}
