import { useCallback, useEffect, useState } from 'react';
import { get } from '../api.js';
import { Alert, Empty, Loading, PageHead } from '../components/ui.jsx';
import { optionLetter, optionText } from '../components/questions.jsx';

export default function WrongBook() {
  const [courses, setCourses] = useState([]);
  const [courseCode, setCourseCode] = useState('');
  const [filters, setFilters] = useState({ sectionTypes: [], knowledgePoints: [] });
  const [sectionType, setSectionType] = useState('');
  const [tag, setTag] = useState('');
  const [showCorrected, setShowCorrected] = useState(false);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/courses').then((r) => {
      setCourses(r.courses);
      if (r.courses.length === 1) setCourseCode(r.courses[0].course_code);
    }).catch((e) => setError(e.message));
    get('/wrongbook/filters').then(setFilters).catch(() => {});
  }, []);

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (courseCode) qs.set('courseCode', courseCode);
    if (sectionType) qs.set('sectionType', sectionType);
    if (tag) qs.set('knowledgePoint', tag);
    if (showCorrected) qs.set('includeCorrected', '1');
    setData(null);
    get(`/wrongbook?${qs}`).then(setData).catch((e) => setError(e.message));
  }, [courseCode, sectionType, tag, showCorrected]);

  useEffect(() => { load(); }, [load]);

  return (
    <>
      <PageHead title="错题本" desc="做错的题会自动收进来，连续答对两次后标记为已订正" />
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row">
          {courses.length > 1 ? (
            <select className="input" style={{ width: 'auto', minWidth: 160 }}
              value={courseCode} onChange={(e) => setCourseCode(e.target.value)}>
              <option value="">全部课程</option>
              {courses.map((c) => (
                <option key={c.course_code} value={c.course_code}>{c.course_name}</option>
              ))}
            </select>
          ) : null}
          <select className="input" style={{ width: 'auto', minWidth: 150 }}
            value={sectionType} onChange={(e) => setSectionType(e.target.value)}>
            <option value="">全部题型</option>
            {filters.sectionTypes.map((t) => (
              <option key={t.section_type} value={t.section_type}>
                {t.section_type}（{t.n}）
              </option>
            ))}
          </select>
          <select className="input" style={{ width: 'auto', minWidth: 150 }}
            value={tag} onChange={(e) => setTag(e.target.value)}>
            <option value="">全部考点</option>
            {filters.knowledgePoints.map((k) => (
              <option key={k.name} value={k.name}>{k.name}（{k.n}）</option>
            ))}
          </select>
          <label className="row" style={{ flexWrap: 'nowrap', minHeight: 44 }}>
            <input type="checkbox" checked={showCorrected} style={{ width: 18, height: 18 }}
              onChange={(e) => setShowCorrected(e.target.checked)} />
            <span className="small">显示已订正</span>
          </label>
        </div>
      </div>

      {!data ? <Loading /> : data.items.length === 0 ? (
        <Empty>{showCorrected ? '还没有错题记录' : '没有待订正的错题，做几套题试试'}</Empty>
      ) : (
        <>
          <p className="small muted">共 {data.total} 道</p>
          <div className="stack">
            {data.items.map((it) => (
              <div className="card" key={it.id}>
                <button
                  onClick={() => setOpen(open === it.id ? null : it.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    border: 'none', background: 'none', padding: 16,
                  }}
                >
                  <div className="row" style={{ marginBottom: 6 }}>
                    <span className="badge gray">{it.sectionType}</span>
                    <span className="badge danger">错 {it.wrongCount} 次</span>
                    <span className="tiny muted">来自{it.source}</span>
                    {it.corrected ? <span className="badge ok">已订正</span> : null}
                    {it.aiStatus === '待重试' ? <span className="badge warn">解析待重试</span> : null}
                  </div>
                  <div className="small" style={{ color: 'var(--ink-2)' }}>
                    {(it.stem || '').slice(0, 90)}
                  </div>
                  <div className="row tiny faint" style={{ marginTop: 6 }}>
                    {it.knowledgePoints.map((k) => <span key={k} className="tag">{k}</span>)}
                  </div>
                </button>

                {open === it.id ? (
                  <div style={{ borderTop: '1px solid var(--line)', padding: 16 }}>
                    <div className="q-stem" style={{ marginBottom: 10 }}>{it.stem}</div>
                    {it.options?.length ? (
                      <div style={{ marginBottom: 10 }}>
                        {it.options.map((o, i) => {
                          const letter = optionLetter(o, i);
                          let cls = 'choice';
                          if (letter === it.correctAnswer) cls += ' right';
                          else if (letter === it.lastAnswer) cls += ' wrong';
                          return (
                            <div key={i} className={cls}>
                              <span><span className="key">{letter}.</span> {optionText(o)}</span>
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="small">
                        你的答案：<strong className="mono">{it.lastAnswer || '（未作答）'}</strong>
                        <span style={{ marginLeft: 12 }}>
                          正确答案：<strong className="mono">{it.correctAnswer}</strong>
                        </span>
                      </p>
                    )}

                    {it.errorAnalysis ? (
                      <div className="card card-pad" style={{ background: '#fafbfc', marginBottom: 10 }}>
                        <div className="tiny muted">错在哪</div>
                        <div className="small">{it.errorAnalysis}</div>
                        {it.memoryPoint ? (
                          <>
                            <div className="tiny muted" style={{ marginTop: 8 }}>记住这点</div>
                            <div className="small">{it.memoryPoint}</div>
                          </>
                        ) : null}
                      </div>
                    ) : (
                      <p className="tiny muted">
                        {it.aiStatus === '待重试'
                          ? 'AI 解析上次失败了，下次跑批改时会重试。'
                          : 'AI 解析还没生成，去成绩报告页点一次「生成 AI 解析」。'}
                      </p>
                    )}

                    {it.explanation ? (
                      <details>
                        <summary className="small muted" style={{ cursor: 'pointer', minHeight: 32 }}>
                          题库原有解析
                        </summary>
                        <div className="passage" style={{ marginTop: 6 }}>{it.explanation}</div>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
