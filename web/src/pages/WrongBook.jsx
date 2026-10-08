import { useEffect, useState } from 'react';
import { get, post } from '../api.js';
import { Alert, Empty, Loading, PageHead } from '../components/ui.jsx';
import { optionLetter, optionText } from '../components/questions.jsx';
import { useSubject } from '../subject.jsx';

export default function WrongBook() {
  const { courses: subjectCourses } = useSubject();
  const [courseCode, setCourseCode] = useState('');
  const [filters, setFilters] = useState({ sectionTypes: [], knowledgePoints: [] });
  const [sectionType, setSectionType] = useState('');
  const [tag, setTag] = useState('');
  const [showCorrected, setShowCorrected] = useState(false);
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(null);
  const [error, setError] = useState('');
  // 逐题生成错因分析（学-1）：正在跑的那一道、跑失败的那一道的提示
  const [analyzing, setAnalyzing] = useState(null);
  const [aiError, setAiError] = useState(null);

  async function analyze(it) {
    setAnalyzing(it.id); setAiError(null);
    try {
      const r = await post(`/wrongbook/${it.id}/analyze`);
      if (r.item) {
        setData((d) => ({ ...d, items: d.items.map((x) => (x.id === it.id ? { ...x, ...r.item } : x)) }));
      }
    } catch (e) {
      setAiError({ id: it.id, message: e.message });
      // 失败了状态会变成「待重试」：照服务端的结果更新，按钮文案跟着变
      if (e.payload?.item) {
        setData((d) => ({ ...d, items: d.items.map((x) => (x.id === it.id ? { ...x, ...e.payload.item } : x)) }));
      }
    } finally { setAnalyzing(null); }
  }

  // 课程码只从本学科的课程里取，取定之前不发请求（CR-H1）。第一版初始是空串、
  // 挂载时就发了一次：不带课程码的 /wrongbook 是跨学科的，会先把别的学科的错题拉回来，
  // 再和随后那次带课程码的请求竞速——后到的那份留在页面上。
  // 依赖里必须带 subjectCourses：切学科时课程码要跟着换成新学科的，
  // 否则会停在上一个学科的课程上。
  useEffect(() => {
    setCourseCode((cur) => (subjectCourses.some((c) => c.course_code === cur)
      ? cur : subjectCourses[0]?.course_code || ''));
    get('/wrongbook/filters').then(setFilters).catch(() => {});
  }, [subjectCourses]);

  const ready = subjectCourses.some((c) => c.course_code === courseCode);

  useEffect(() => {
    if (!ready) { setData(null); return undefined; }
    let stale = false;
    const qs = new URLSearchParams({ courseCode });
    if (sectionType) qs.set('sectionType', sectionType);
    if (tag) qs.set('knowledgePoint', tag);
    if (showCorrected) qs.set('includeCorrected', '1');
    setData(null);
    get(`/wrongbook?${qs}`)
      .then((d) => { if (!stale) setData(d); })
      .catch((e) => { if (!stale) setError(e.message); });
    return () => { stale = true; };
  }, [ready, courseCode, sectionType, tag, showCorrected]);

  return (
    <>
      <PageHead title="错题本" desc="做错的题会自动收进来，连续答对两次后标记为已订正" />
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row">
          {subjectCourses.length > 1 ? (
            <select className="input" style={{ width: 'auto', minWidth: 160 }}
              value={courseCode} onChange={(e) => setCourseCode(e.target.value)}>
              {/* 没有「全部课程」：不带课程码的 /wrongbook 是跨学科的，不是"本学科全部" */}
              {subjectCourses.map((c) => (
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

      {!subjectCourses.length ? <Empty>本学科还没有开设课程</Empty> : !data ? <Loading /> : data.items.length === 0 ? (
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
                      // 多空题以前原样显示：你的答案是 {"1":"碳"} 代码、正确答案一栏空着（答案逐空存在
                      // 得分单元里）。服务端拼好人话版本（answer-key.js），这里只管显示（2026-10-07）。
                      <div className="stack small" style={{ gap: 4, marginBottom: 10 }}>
                        <div>
                          你的答案：<strong className="mono" data-testid="wb-my-answer">
                            {it.lastAnswerText || it.lastAnswer || '（未作答）'}</strong>
                        </div>
                        <div>
                          正确答案：<strong className="mono" data-testid="wb-answer-key">
                            {it.answerKeyText || it.correctAnswer || '（题库里没有录入）'}</strong>
                        </div>
                      </div>
                    )}

                    {it.errorAnalysis ? (
                      <div className="card card-pad" style={{ background: '#fafbfc', marginBottom: 10 }}
                        data-testid="wb-analysis">
                        {/* 再错一次之后状态标回「待生成」（学-2），这时显示的还是上一次的分析，要说出来 */}
                        {it.aiStatus !== '已生成' ? (
                          <div className="tiny" style={{ color: 'var(--warn, #b26b00)', marginBottom: 6 }}
                            data-testid="wb-analysis-stale">
                            这次又错了，下面还是上一次的分析
                          </div>
                        ) : null}
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
                        {it.aiStatus === '待重试' ? 'AI 错因分析上次没生成出来。' : '还没有 AI 错因分析。'}
                      </p>
                    )}
                    {/* 以前这里写「去成绩报告页点一次」——练习里做错的题没有报告页，永远等不到（学-1） */}
                    {it.aiStatus !== '已生成' ? (
                      <div style={{ marginBottom: 10 }}>
                        <button type="button" className="btn ghost" data-testid="wb-analyze"
                          onClick={() => analyze(it)} disabled={analyzing === it.id}>
                          {analyzing === it.id ? '正在生成……'
                            : it.errorAnalysis ? '按这次的作答重新分析' : '生成错因分析'}
                        </button>
                        {aiError?.id === it.id ? (
                          <div className="tiny" style={{ color: 'var(--danger)', marginTop: 6 }}>{aiError.message}</div>
                        ) : null}
                      </div>
                    ) : null}

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
