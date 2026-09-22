import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, patch, post } from '../../api.js';
import { Alert, Loading, StatusBadge } from '../../components/ui.jsx';

export default function BankReview() {
  const { examId } = useParams();
  const [data, setData] = useState(null);
  const [tags, setTags] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    const r = await get(`/admin/bank/exams/${examId}`);
    setData(r);
    return r;
  }, [examId]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
    get('/admin/bank/knowledge-points')
      .then((r) => setTags(r.knowledgePoints.map((k) => k.name)))
      .catch(() => {});
  }, [load]);

  const allQuestions = useMemo(
    () => (data ? data.sections.flatMap((s) => s.questions.map((q) => ({ ...q, section: s }))) : []),
    [data]
  );
  const current = selected ? allQuestions.find((q) => q.question_id === selected) : null;
  const openNotes = data ? data.parsingNotes.filter((n) => !n.resolved).length : 0;

  async function toggleNote(note) {
    await patch(`/admin/bank/notes/${note.id}`, { resolved: !note.resolved });
    await load();
  }

  async function publish() {
    setError(''); setNotice('');
    try {
      const r = await post(`/admin/bank/exams/${examId}/publish`);
      setNotice(`已发布 ${r.published} 题${r.held ? `，${r.held} 题因标记存疑暂不发布` : ''}`);
      await load();
    } catch (e) { setError(e.message); }
  }

  async function unpublish() {
    setError(''); setNotice('');
    try {
      await post(`/admin/bank/exams/${examId}/unpublish`);
      setNotice('已撤回发布，题目回到草稿状态');
      await load();
    } catch (e) { setError(e.message); }
  }

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;

  const { exam } = data;
  const reviewedCount = allQuestions.filter((q) => q.reviewed).length;

  return (
    <>
      <div className="page-head">
        <Link className="small" to="/admin/bank">← 返回试卷列表</Link>
        <div className="spread" style={{ marginTop: 8 }}>
          <div>
            <h1>{exam.title}</h1>
            <p>
              {exam.course_name}（{exam.course_code}） · 共 {allQuestions.length} 题 ·
              已校对 {reviewedCount} 题
            </p>
          </div>
          <StatusBadge status={exam.status} />
        </div>
      </div>

      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {notice ? <div style={{ marginBottom: 12 }}><Alert kind="success">{notice}</Alert></div> : null}

      {data.parsingNotes.length > 0 ? (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <div className="spread" style={{ marginBottom: 10 }}>
            <h2 style={{ fontSize: 16 }}>解析存疑</h2>
            <span className={`badge ${openNotes ? 'danger' : 'ok'}`}>
              {openNotes ? `${openNotes} 条待处理` : '全部已处理'}
            </span>
          </div>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            这些是解析时无法确定的地方，逐条核对原卷后勾掉；全部处理完才能发布整卷。
          </p>
          <div className="stack">
            {data.parsingNotes.map((n) => (
              <label key={n.id} className="row" style={{ alignItems: 'flex-start', flexWrap: 'nowrap' }}>
                <input
                  type="checkbox" checked={Boolean(n.resolved)}
                  onChange={() => toggleNote(n)}
                  style={{ width: 18, height: 18, marginTop: 4, flexShrink: 0 }}
                />
                <span className={`small${n.resolved ? ' faint' : ''}`}
                  style={n.resolved ? { textDecoration: 'line-through' } : undefined}>
                  {n.note}
                </span>
              </label>
            ))}
          </div>
        </div>
      ) : null}

      {current ? (
        <QuestionEditor
          key={current.question_id}
          question={current}
          tagLibrary={tags}
          onClose={() => setSelected(null)}
          onSaved={async () => { await load(); setSelected(null); }}
        />
      ) : (
        <>
          {data.sections.map((s) => (
            <div className="card card-pad" key={s.section_id} style={{ marginBottom: 16 }}>
              <div className="spread" style={{ marginBottom: 8 }}>
                <h2 style={{ fontSize: 16 }}>{s.type}</h2>
                <span className="tiny faint">
                  {s.questions.length} 题
                  {s.score_per_question ? ` · 每题 ${s.score_per_question} 分` : ''}
                </span>
              </div>
              {s.passage_text ? (
                <details style={{ marginBottom: 12 }}>
                  <summary className="small muted" style={{ cursor: 'pointer', minHeight: 32 }}>
                    查看原文{s.passage_title ? `：${s.passage_title}` : ''}
                  </summary>
                  <div className="passage" style={{ marginTop: 8 }}>{s.passage_text}</div>
                </details>
              ) : null}
              {s.writing_prompt ? <div className="passage" style={{ marginBottom: 12 }}>{s.writing_prompt}</div> : null}

              <div className="stack">
                {s.questions.map((q) => (
                  <button
                    key={q.question_id}
                    onClick={() => setSelected(q.question_id)}
                    className="card card-pad"
                    style={{ display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer', border: '1px solid var(--line)' }}
                  >
                    <div className="spread" style={{ marginBottom: 4 }}>
                      <strong className="small">第 {q.ord} 题</strong>
                      <span className="row" style={{ gap: 6 }}>
                        {q.reviewed ? <span className="badge ok">已校对</span> : null}
                        <StatusBadge status={q.status} />
                      </span>
                    </div>
                    <div className="small" style={{ color: 'var(--ink-2)' }}>
                      {(q.stem || '（无题干）').slice(0, 120)}
                    </div>
                    <div className="row tiny faint" style={{ marginTop: 6 }}>
                      <span>答案：{q.answer || '—'}</span>
                      {q.knowledgePoints.map((k) => <span key={k} className="tag">{k}</span>)}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          ))}

          <div className="sticky-actions">
            {exam.status === '已发布'
              ? <button className="btn danger" onClick={unpublish}>撤回发布</button>
              : <button className="btn" onClick={publish} disabled={openNotes > 0}>
                  {openNotes > 0 ? `还有 ${openNotes} 条存疑待处理` : '发布整卷'}
                </button>}
          </div>
        </>
      )}
    </>
  );
}

function QuestionEditor({ question, tagLibrary, onClose, onSaved }) {
  const [form, setForm] = useState({
    stem: question.stem || '',
    options: question.options || [],
    answer: question.answer || '',
    answerExplanation: question.answer_explanation || '',
    status: question.status,
    reviewed: Boolean(question.reviewed),
    knowledgePoints: question.knowledgePoints,
  });
  const [newTag, setNewTag] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const section = question.section;

  async function save() {
    setBusy(true); setError('');
    try {
      await patch(`/admin/bank/questions/${question.question_id}`, {
        ...form,
        options: form.options.length ? form.options : null,
      });
      await onSaved();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="review-split">
      {/* 左栏：原文对照。PC 上吸顶常驻，移动端折叠到上方 */}
      <div className="card card-pad review-source">
        <div className="spread" style={{ marginBottom: 8 }}>
          <h2 style={{ fontSize: 15 }}>原文对照</h2>
          <span className="tiny faint">{section.type}</span>
        </div>
        {section.passage_title ? <strong className="small">{section.passage_title}</strong> : null}
        {section.passage_text || section.writing_prompt ? (
          <div className="passage" style={{ marginTop: 8 }}>
            {section.passage_text || section.writing_prompt}
          </div>
        ) : <p className="small faint">本部分没有独立原文，题干即全部内容。</p>}
      </div>

      {/* 右栏：编辑表单 */}
      <div className="card card-pad">
        <div className="spread" style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: 15 }}>第 {question.ord} 题</h2>
          <button className="btn ghost sm" onClick={onClose}>返回列表</button>
        </div>

        {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}

        <div className="field">
          <label htmlFor="stem">题干</label>
          <textarea id="stem" className="textarea" value={form.stem}
            onChange={(e) => set('stem', e.target.value)} />
        </div>

        {form.options.length > 0 ? (
          <div className="field">
            <label>选项</label>
            <div className="stack">
              {form.options.map((opt, i) => (
                <div className="opt-row" key={i}>
                  <span className="small muted" style={{ width: 18 }}>{'ABCD'[i] || i + 1}</span>
                  <input className="input" value={opt}
                    onChange={(e) => {
                      const next = [...form.options];
                      next[i] = e.target.value;
                      set('options', next);
                    }} />
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="field">
          <label htmlFor="answer">参考答案</label>
          <textarea id="answer" className="textarea" style={{ minHeight: 60 }} value={form.answer}
            onChange={(e) => set('answer', e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="expl">解析</label>
          <textarea id="expl" className="textarea" value={form.answerExplanation}
            onChange={(e) => set('answerExplanation', e.target.value)} />
        </div>

        <div className="field">
          <label>考点标签</label>
          <div className="row" style={{ marginBottom: 8 }}>
            {form.knowledgePoints.map((k) => (
              <span className="tag" key={k}>
                {k}
                <button type="button" aria-label={`移除 ${k}`}
                  onClick={() => set('knowledgePoints', form.knowledgePoints.filter((x) => x !== k))}>×</button>
              </span>
            ))}
            {form.knowledgePoints.length === 0 ? <span className="small faint">尚未标注</span> : null}
          </div>
          <div className="row" style={{ flexWrap: 'nowrap' }}>
            <input className="input" list="kp-library" value={newTag} placeholder="输入或选择考点"
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } }} />
            <button type="button" className="btn ghost sm" onClick={addTag}>添加</button>
          </div>
          <datalist id="kp-library">
            {tagLibrary.map((t) => <option key={t} value={t} />)}
          </datalist>
        </div>

        <div className="field">
          <label htmlFor="status">题目状态</label>
          <select id="status" className="input" value={form.status}
            onChange={(e) => set('status', e.target.value)}>
            <option value="草稿">草稿</option>
            <option value="已发布">已发布</option>
            <option value="存疑">存疑（不随整卷发布）</option>
          </select>
        </div>

        <label className="row" style={{ flexWrap: 'nowrap', minHeight: 44 }}>
          <input type="checkbox" checked={form.reviewed} style={{ width: 18, height: 18 }}
            onChange={(e) => set('reviewed', e.target.checked)} />
          <span className="small">标记为已校对</span>
        </label>

        <div className="sticky-actions">
          <button className="btn" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
          <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
        </div>
      </div>
    </div>
  );

  function addTag() {
    const name = newTag.trim();
    if (!name || form.knowledgePoints.includes(name)) { setNewTag(''); return; }
    set('knowledgePoints', [...form.knowledgePoints, name]);
    setNewTag('');
  }
}
