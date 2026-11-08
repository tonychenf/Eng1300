import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, post, put } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

// 组卷模板（改进阶段 2 P1-B1～B4）。每行一个部分：名称、从哪类题里抽、怎么抽、抽几题、每题几分。
// 手机上每行是一张卡；没有模板时可以"按一份样卷生成草稿"，只填分值。
// 保存时服务端校验合计 = 满分（拍板 3），两人同时改时后到的 409。

const toKey = (f) => (f?.questionTypes ? `t:${f.questionTypes[0]}` : f?.sectionTypes ? `s:${f.sectionTypes[0]}` : '');
const fromKey = (k) => (k.startsWith('t:') ? { questionTypes: [k.slice(2)] } : k.startsWith('s:') ? { sectionTypes: [k.slice(2)] } : {});
const cents = (x) => Math.round(Number(x) * 100);

export default function TemplateEdit() {
  const { id } = useParams();
  const [view, setView] = useState(null);
  const [rows, setRows] = useState([]);
  const [exams, setExams] = useState([]);
  const [draftFrom, setDraftFrom] = useState('');
  const [error, setError] = useState('');
  const [problems, setProblems] = useState([]);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  const apply = (v) => {
    setView(v);
    setRows(v.items.map((r) => ({ ...r, filterKey: toKey(r.filter) })));
  };
  useEffect(() => {
    get(`/admin/subjects/${id}/template`).then((v) => {
      apply(v);
      return get(`/admin/bank/exams?courseCode=${encodeURIComponent(v.course.courseCode)}`);
    }).then((r) => setExams(r?.exams || [])).catch((e) => setError(e.message));
  }, [id]);

  const total = useMemo(() => rows.reduce((n, r) => n + cents((Number(r.questionCount) || 0) * (Number(r.scorePerQuestion) || 0)), 0) / 100, [rows]);
  const readinessOf = (i) => view?.readiness?.parts?.[i];

  const set = (i, k, v) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, [k]: v } : r)));
  const move = (i, d) => setRows((rs) => {
    const j = i + d; if (j < 0 || j >= rs.length) return rs;
    const n = [...rs]; [n[i], n[j]] = [n[j], n[i]]; return n;
  });

  async function draft() {
    setError(''); setMsg('');
    try {
      const r = await post(`/admin/subjects/${id}/template/draft`, { examId: draftFrom });
      setRows(r.items.map((it) => ({ ...it, scorePerQuestion: '', filterKey: toKey(it.filter) })));
      setMsg(`按「${r.from.label}」生成了 ${r.items.length} 个部分，照试卷说明填上每题几分再保存。`);
    } catch (e) { setError(e.message); }
  }

  async function save() {
    setError(''); setMsg(''); setProblems([]); setBusy(true);
    try {
      const v = await put(`/admin/subjects/${id}/template`, {
        version: view.version,
        items: rows.map((r) => ({
          label: String(r.label || '').trim(), filter: fromKey(r.filterKey || ''), pickUnit: r.pickUnit,
          questionCount: Number(r.questionCount), scorePerQuestion: Number(r.scorePerQuestion),
        })),
      });
      apply(v);
      setMsg('保存好了。只影响以后组的卷。');
    } catch (e) {
      setError(e.code === 'template_changed' ? '模板刚被别人改过，请刷新页面后再改。' : e.message);
      setProblems(e.payload?.problems || []);
    }
    setBusy(false);
  }

  if (error && !view) return <Alert>{error}</Alert>;
  if (!view) return <Loading />;
  const expected = view.expected;
  const diff = Math.round((total - expected) * 100) / 100;

  return (
    <>
      <PageHead title={`组卷模板：${view.subject.name}`} desc={`满分 ${expected} 分 · ${view.course.timeLimitMinutes} 分钟。只影响以后组的卷。`} />
      <p className="small"><Link to={`/admin/subjects/${id}/setup`}>← 返回开新课引导</Link></p>
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {problems.length > 1 ? (
        <div style={{ marginBottom: 12 }}><Alert>{problems.map((p) => <div key={p}>{p}</div>)}</Alert></div>
      ) : null}
      {msg ? <div style={{ marginBottom: 12 }}><Alert kind="success">{msg}</Alert></div> : null}

      {!rows.length ? (
        <div className="card card-pad" style={{ marginBottom: 12 }} data-testid="draft-card">
          <strong className="small">按一份样卷生成草稿</strong>
          <p className="tiny muted">选一份整套的样卷，按它的结构生成几个部分、每部分抽什么、抽几题。你只要填每题几分。</p>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <select className="input" style={{ flex: '1 1 200px' }} value={draftFrom} onChange={(e) => setDraftFrom(e.target.value)} data-testid="draft-from">
              <option value="">选一份样卷</option>
              {exams.map((e) => <option key={e.exam_id} value={e.exam_id}>{e.label || e.title}</option>)}
            </select>
            <button className="btn sm" onClick={draft} disabled={!draftFrom} data-testid="draft-go">生成草稿</button>
          </div>
        </div>
      ) : null}

      <div className={`card card-pad template-total${cents(total) === cents(expected) ? '' : ' bad'}`} style={{ marginBottom: 12 }} data-testid="template-total">
        合计 <strong>{total}</strong> 分 / 满分 {expected} 分
        {diff < 0 ? <span className="badge danger" style={{ marginLeft: 8 }}>还差 {-diff} 分</span> : null}
        {diff > 0 ? <span className="badge danger" style={{ marginLeft: 8 }}>多了 {diff} 分</span> : null}
      </div>

      <div className="stack template-rows">
        {rows.map((r, i) => {
          const rd = readinessOf(i);
          return (
            <div key={i} className="card card-pad template-row" data-testid="template-row">
              <div className="spread" style={{ marginBottom: 8 }}>
                <strong className="small">第 {i + 1} 部分</strong>
                <span className="row" style={{ gap: 4 }}>
                  <button className="btn ghost sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label="上移">↑</button>
                  <button className="btn ghost sm" onClick={() => move(i, 1)} disabled={i === rows.length - 1} aria-label="下移">↓</button>
                  <button className="btn ghost sm" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))}>删除</button>
                </span>
              </div>
              <div className="template-fields">
                <label className="field">
                  <span className="tiny muted">名称（学员看到的部分名）</span>
                  <input className="input" value={r.label || ''} maxLength={20} onChange={(e) => set(i, 'label', e.target.value)} />
                </label>
                <label className="field">
                  <span className="tiny muted">从哪类题里抽</span>
                  <select className="input" value={r.filterKey || ''} onChange={(e) => set(i, 'filterKey', e.target.value)}>
                    <option value="">请选择</option>
                    <optgroup label="按大题类别">
                      {view.choices.sectionTypes.map((s) => <option key={s.name} value={`s:${s.name}`}>{s.name}（{s.questions} 题）</option>)}
                    </optgroup>
                    {r.pickUnit !== 'SECTION' ? (
                      <optgroup label="按题型">
                        {view.choices.questionTypes.map((t) => <option key={t.code} value={`t:${t.code}`}>{t.name}</option>)}
                      </optgroup>
                    ) : null}
                  </select>
                </label>
                <div className="field">
                  <span className="tiny muted">怎么抽</span>
                  <div className="row" style={{ gap: 6 }}>
                    <button type="button" className={`btn sm${r.pickUnit === 'QUESTION' ? '' : ' ghost'}`}
                      onClick={() => set(i, 'pickUnit', 'QUESTION')}>一道一道抽</button>
                    <button type="button" className={`btn sm${r.pickUnit === 'SECTION' ? '' : ' ghost'}`}
                      onClick={() => setRows((rs) => rs.map((x, j) => (j === i ? { ...x, pickUnit: 'SECTION', filterKey: x.filterKey?.startsWith('t:') ? '' : x.filterKey } : x)))}>整篇抽</button>
                  </div>
                  <span className="tiny faint">阅读、完形、段落填空这类带文章的选整篇抽</span>
                </div>
                <label className="field">
                  <span className="tiny muted">{r.pickUnit === 'SECTION' ? '每篇几题（只抽一篇）' : '抽几题'}</span>
                  <input className="input" inputMode="numeric" value={r.questionCount ?? ''} onChange={(e) => set(i, 'questionCount', e.target.value)} />
                </label>
                <label className="field">
                  <span className="tiny muted">每题几分</span>
                  <input className={`input${r.scorePerQuestion === '' || r.scorePerQuestion == null ? ' need' : ''}`} inputMode="decimal"
                    value={r.scorePerQuestion ?? ''} onChange={(e) => set(i, 'scorePerQuestion', e.target.value)} data-testid="score-input" />
                </label>
              </div>
              <div className="tiny" style={{ marginTop: 6 }}>
                小计 {Math.round((Number(r.questionCount) || 0) * (Number(r.scorePerQuestion) || 0) * 100) / 100} 分
                {rd ? (
                  <span className={rd.ok ? 'muted' : 'danger-text'} style={{ marginLeft: 12 }}>
                    {rd.pickUnit === 'SECTION' ? `可选 ${rd.available} 篇` : `可选 ${rd.available} 题 / 需要 ${rd.required}`}
                    {rd.ok ? ' ✓' : (rd.pickUnit === 'SECTION' ? '，凑不够' : `，差 ${rd.required - rd.available} 题`)}
                  </span>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
      <p style={{ marginTop: 8 }}>
        <button className="btn ghost sm" onClick={() => setRows((rs) => [...rs, { label: '', filterKey: '', pickUnit: 'QUESTION', questionCount: 1, scorePerQuestion: '' }])}>
          加一个部分
        </button>
      </p>

      <div className="sticky-actions">
        <button className="btn" onClick={save} disabled={busy || !rows.length} data-testid="template-save">
          {busy ? '保存中…' : '保存'}
        </button>
      </div>
    </>
  );
}
