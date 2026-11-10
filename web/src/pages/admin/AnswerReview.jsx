import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getToken, get, patch, post } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';
import { prepareUpload } from '../../lib/photo-qc.js';

// 核答案模式（改进阶段 2 第三期 D，PRD 7.2）：/admin/bank/:examId/answers
//   有疑点的一题一屏（题面有问题 → 和书上手写 / 原书答案页不一致 → AI 拿不准 → 还没答案），「对」「改」两个大按钮在屏幕下半部；
//   没有疑点的折成一行「其余 N 题没有疑点 · 整组确认」；能传原书答案页比对、能下载核对单。
// 「对」「改」走校对页那个保存接口（带标准答案自检、确认留痕），不另写一套。

const REASON_BADGE = { stem: 'danger', book: 'danger', hand: 'warn', unsure: 'warn', missing: 'gray' };

export default function AnswerReview() {
  const { examId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [i, setI] = useState(0);
  const [editing, setEditing] = useState(false);

  const load = () => get(`/admin/bank/exams/${examId}/answer-queue`).then((d) => { setData(d); return d; }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [examId]);

  async function act(label, fn, after) {
    setError(''); setBusy(label);
    try { const r = await fn(); if (after) after(r); setEditing(false); await load(); } catch (e) { setError(e.message); } finally { setBusy(''); }
  }

  async function uploadAnswerPage(file) {
    if (!file) return;
    const image = await prepareUpload(file, 2400);
    await act('识别答案页', () => post(`/admin/bank/exams/${examId}/answer-page`, { image }), (r) => {
      setI(0);
      setMsg(`答案页读出 ${r.read} 题，比上 ${r.compared} 题：一致 ${r.same} 题，不一致 ${r.diff.length} 题（排到最前面）` +
        `${r.rate != null ? `；一致率 ${(r.rate * 100).toFixed(1)}%` : ''}${r.stemKept?.length ? `；第 ${r.stemKept.join('、')} 题答案一致但题面有问题，没替你确认` : ''}${r.ambiguous.length ? `；第 ${r.ambiguous.join('、')} 题对不上是哪一部分，没比` : ''}`);
    });
  }
  async function downloadChecklist() {
    const r = await fetch(`/api/admin/bank/exams/${examId}/checklist`, { headers: { Authorization: `Bearer ${getToken()}` } });
    const text = await r.text();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
    // 文件名用英文：中文名在测试用的无头 Chromium 里被丢掉、存下来叫 download、没有扩展名（2026-11-11 浏览器测试照出来的，
    // 换成英文名当场就对）；手机上的内置浏览器对中文名也不一定认。挂进页面再点，老一点的浏览器才认 download
    a.download = `answer-checklist-${examId}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  const { flagged, rest } = data;
  const cur = flagged[Math.min(i, Math.max(0, flagged.length - 1))];

  return (
    <>
      <PageHead title="核答案" desc={data.exam.label} />
      <p className="small"><Link to={`/admin/bank/${examId}`}>← 回到校对页</Link></p>
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {msg ? <div style={{ marginBottom: 12 }}><Alert kind="success">{msg}</Alert></div> : null}

      <div className="card card-pad" style={{ marginBottom: 12 }} data-testid="answers-head">
        <div className="spread">
          <strong className="small">已确认 {data.confirmed} / 共 {data.total} 题 · 有疑点 {flagged.length} 题</strong>
          {data.bookCompare ? <span className="tiny muted" data-testid="answers-book-rate">与原书答案页一致 {(data.bookCompare.rate * 100).toFixed(1)}%（比了 {data.bookCompare.compared} 题）</span> : null}
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8 }}>
          <label className={`btn ghost sm${busy ? ' disabled' : ''}`}>上传原书答案页
            <input type="file" accept="image/*" className="visually-hidden" data-testid="answers-page-file"
              onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; uploadAnswerPage(f); }} />
          </label>
          <button className="btn ghost sm" onClick={downloadChecklist} data-testid="answers-checklist">下载核对单</button>
        </div>
        {busy ? <p className="small" style={{ margin: '8px 0 0' }}>{busy}…</p> : null}
      </div>

      {cur ? (
        <div className="card card-pad stack answer-card" data-testid="answers-card">
          <div className="spread">
            <span className="small muted">第 {Math.min(i, flagged.length - 1) + 1} / {flagged.length} 道有疑点的 · {cur.sectionType} 第 {cur.ord} 题{cur.sourcePage ? ` · 出自第 ${cur.sourcePage} 页` : ''}</span>
            <span className="row" style={{ gap: 6 }}>
              <button className="btn ghost sm" disabled={i <= 0} onClick={() => { setI(i - 1); setEditing(false); }}>上一题</button>
              <button className="btn ghost sm" disabled={i >= flagged.length - 1} onClick={() => { setI(i + 1); setEditing(false); }}>下一题</button>
            </span>
          </div>
          {cur.reasons.map((r) => <div key={r.kind} className={`badge ${REASON_BADGE[r.kind] || 'gray'}`} style={{ whiteSpace: 'normal' }} data-testid="answers-reason">{r.text}</div>)}
          <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{cur.stem}</div>
          {cur.options ? (
            <div className="stack">
              {cur.options.map((o) => {
                const letter = String(o).trim().slice(0, 1).toUpperCase();
                return <div key={o} className={`answer-opt${letter === cur.answer ? ' picked' : ''}`}>{o}</div>;
              })}
            </div>
          ) : null}
          <div>
            <div className="tiny muted">AI 的答案</div>
            <div className="answer-big" data-testid="answers-ai">{cur.answer ?? '（还没有答案）'}</div>
            {cur.explanation ? <div className="small muted" style={{ marginTop: 4 }}>{cur.explanation}</div> : null}
          </div>
          {editing ? <Fix q={cur} busy={busy} onSave={(body) => act('改答案', () => patch(`/admin/bank/questions/${cur.questionId}`, { ...body, answerState: '已确认' }), () => setMsg(`第 ${cur.ord} 题已改并确认`))} /> : null}
          <div className="answer-actions">
            <button className="btn big" data-testid="answers-ok" disabled={Boolean(busy) || !cur.answer}
              onClick={() => act('确认', () => patch(`/admin/bank/questions/${cur.questionId}`, { answerState: '已确认' }), () => setMsg(`第 ${cur.ord} 题已确认`))}>对</button>
            <button className="btn ghost big" data-testid="answers-fix" disabled={Boolean(busy)} onClick={() => setEditing(!editing)}>{editing ? '先不改' : '改'}</button>
          </div>
        </div>
      ) : (
        <div className="card card-pad" data-testid="answers-no-flagged"><p className="small" style={{ margin: 0 }}>没有有疑点的题了。</p></div>
      )}

      {rest.length ? (
        <div className="card card-pad" style={{ marginTop: 12 }} data-testid="answers-rest">
          <div className="spread">
            <span className="small">其余 {rest.length} 题没有疑点</span>
            <button className="btn sm" data-testid="answers-confirm-rest" disabled={Boolean(busy)}
              onClick={() => confirm(`整组确认这 ${rest.length} 题？每道题先跑一遍标准答案自检，过不了的留下。`) && act('整组确认', () => post(`/admin/bank/exams/${examId}/confirm-rest`, { ids: rest.map((q) => q.questionId) }), (r) => setMsg(`整组确认了 ${r.confirmed} 题${r.kept.length ? `；留下 ${r.kept.length} 题：${r.kept.slice(0, 3).map((k) => `第 ${k.ord} 题（${k.reason}）`).join('；')}` : ''}`))}>
              整组确认
            </button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function Fix({ q, busy, onSave }) {
  const inputs = (q.items || []).filter((it) => it.kind === 'BLANK' || it.kind === 'OPTION');
  const [text, setText] = useState(q.answer || '');
  const [blanks, setBlanks] = useState(inputs.map((it) => it.answer || ''));
  if (q.options) {
    return (
      <div className="row" style={{ gap: 8 }} data-testid="answers-fix-choices">
        {q.options.map((o) => {
          const letter = String(o).trim().slice(0, 1).toUpperCase();
          return <button key={o} className="btn ghost" disabled={Boolean(busy)} onClick={() => onSave({ answer: letter })}>{letter}</button>;
        })}
      </div>
    );
  }
  if (inputs.length) {
    return (
      <div className="stack">
        {inputs.map((it, k) => (
          <input key={it.ord} className="input" aria-label={`第 ${it.ord} 空`} value={blanks[k]} onChange={(e) => setBlanks(blanks.map((b, j) => (j === k ? e.target.value : b)))} />
        ))}
        <button className="btn sm" disabled={Boolean(busy)} onClick={() => onSave({ items: inputs.map((it, k) => ({ ord: it.ord, answer: blanks[k] })) })}>保存并确认</button>
      </div>
    );
  }
  return (
    <div className="stack">
      <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="答案" />
      <button className="btn sm" disabled={Boolean(busy)} onClick={() => onSave({ answer: text })}>保存并确认</button>
    </div>
  );
}
