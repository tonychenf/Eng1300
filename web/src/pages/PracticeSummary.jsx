import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../api.js';
import { Alert, Loading, PageHead } from '../components/ui.jsx';
import { useSubject } from '../subject.jsx';

const TIER_STYLE = {
  已掌握: 'ok',
  待巩固: 'warn',
  薄弱: 'danger',
  未测: 'gray',
};

export default function PracticeSummary() {
  const { path } = useSubject();
  const { attemptId } = useParams();
  const navigate = useNavigate();
  const [sum, setSum] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 错题的 AI 错因分析（学-1，2026-10-07）：小结一打开就替这一轮做错的题生成。以前只有模考报告页会调，
  // 练习做错的题永远没有分析。分析失败不影响小结，错题本里每道题还有自己的「生成错因分析」按钮。
  const [ai, setAi] = useState(null);

  useEffect(() => {
    get(`/practice/${attemptId}/summary`).then(setSum).catch((e) => setError(e.message));
  }, [attemptId]);

  const needsAnalysis = !!sum && sum.stats.answered > 0 && sum.stats.accuracy < 100;
  useEffect(() => {
    if (!needsAnalysis) return undefined;
    let alive = true;
    setAi({ state: 'running' });
    post(`/ai/attempts/${attemptId}/run`)
      .then((r) => { if (alive) setAi({ state: 'done', ...(r.wrongItems || { done: 0, failed: 0 }) }); })
      .catch((e) => { if (alive) setAi({ state: 'error', message: e.message }); });
    return () => { alive = false; };
  }, [attemptId, needsAnalysis]);

  async function drill(tagId) {
    setBusy(true); setError('');
    try {
      const r = await post('/practice/drill', { courseCode: sum.attempt.courseCode, tagId });
      navigate(path(`/practice/${r.attemptId}/run`));
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  if (error) return <Alert>{error}</Alert>;
  if (!sum) return <Loading label="正在汇总" />;

  const { stats, knowledgePoints, weakPoints, suggestions, attempt } = sum;
  const byTier = ['薄弱', '待巩固', '已掌握'].map((t) => ({
    tier: t, items: knowledgePoints.filter((k) => k.tier === t),
  })).filter((g) => g.items.length);

  const minutes = Math.max(1, Math.round((attempt.durationSeconds || 0) / 60));

  return (
    <>
      <PageHead title="练习总结" desc={`${attempt.stage} · 用时约 ${minutes} 分钟`} />

      {stats.answered === 0 ? (
        <Alert kind="info">这次没有作答记录，去练一轮再来看总结。</Alert>
      ) : (
        <>
          <div className="grid-cards" style={{ marginBottom: 16 }}>
            <Stat label="做题数" value={stats.answered} />
            <Stat label="正确率" value={`${stats.accuracy}%`} />
            <Stat label="覆盖考点" value={stats.knowledgePointCount} />
          </div>

          <AiCard ai={ai} wrongbook={path('/wrongbook')} />

          {suggestions.length ? (
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, marginBottom: 8 }}>学习方向建议</h2>
              <div className="stack">
                {suggestions.map((s, i) => (
                  <div key={i} className="small" style={{ display: 'flex', gap: 8 }}>
                    <span className="q-num" style={{ flexShrink: 0 }}>{i + 1}</span>
                    <span>{s}</span>
                  </div>
                ))}
              </div>
              <p className="tiny muted" style={{ marginBottom: 0, marginTop: 10 }}>
                目前按掌握度规则生成。接入 AI 后会换成更具体的讲解式建议。
              </p>
            </div>
          ) : null}

          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16, marginBottom: 12 }}>考点掌握情况</h2>
            <div className="stack">
              {byTier.map((g) => (
                <div key={g.tier}>
                  <div className="row" style={{ marginBottom: 6 }}>
                    <span className={`badge ${TIER_STYLE[g.tier]}`}>{g.tier}</span>
                    <span className="tiny muted">{g.items.length} 个考点</span>
                  </div>
                  <div className="row">
                    {g.items.map((k) => (
                      <span key={k.tagId} className="tag">
                        {k.name} <b>{k.sessionCorrect}/{k.sessionTotal}</b>
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {weakPoints.length ? (
            <div className="card card-pad" style={{ marginBottom: 16 }}>
              <h2 style={{ fontSize: 16, marginBottom: 4 }}>要不要针对薄弱考点再练一轮</h2>
              <p className="tiny muted" style={{ marginTop: 0 }}>
                选一个考点，会把该课程下这个考点的全部题目挨个做一遍，同样不限时。
              </p>
              <div className="stack">
                {weakPoints.map((k) => (
                  <div key={k.tagId} className="spread"
                    style={{ padding: '10px 0', borderTop: '1px solid var(--line)' }}>
                    <span>
                      <strong className="small">{k.name}</strong>
                      <span className="tiny muted" style={{ marginLeft: 8 }}>
                        本次 {k.sessionCorrect}/{k.sessionTotal}
                      </span>
                    </span>
                    <button className="btn sm" onClick={() => drill(k.tagId)} disabled={busy}>
                      练这个
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div style={{ marginBottom: 16 }}>
              <Alert kind="success">本次没有出现薄弱考点，可以扩大题型范围或去做一套模考。</Alert>
            </div>
          )}
        </>
      )}

      <div className="sticky-actions">
        <Link className="btn" to={path('/practice/new')}>再练一轮</Link>
        <Link className="btn ghost" to={path('')}>回到首页</Link>
      </div>
    </>
  );
}

function AiCard({ ai, wrongbook }) {
  if (!ai) return null;
  // 这一轮的错题早就分析过（回头再打开小结），或者错的都是练习不判分的题：没什么可说的
  if (ai.state === 'done' && !ai.done && !ai.failed) return null;
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }} data-testid="practice-ai">
      <h2 style={{ fontSize: 16, marginBottom: 8 }}>错题的 AI 错因分析</h2>
      {ai.state === 'running' ? (
        <p className="small muted" style={{ margin: 0 }}>正在为这一轮做错的题生成错因分析……</p>
      ) : ai.state === 'error' ? (
        <p className="small" style={{ margin: 0 }}>
          这次没生成出来：{String(ai.message).replace(/[。.]$/, "")}。可以稍后到 <Link to={wrongbook}>错题本</Link> 里逐题点「生成错因分析」。
        </p>
      ) : (
        <p className="small" style={{ margin: 0 }}>
          {ai.done ? <>已为 {ai.done} 道错题生成分析，去 <Link to={wrongbook}>错题本</Link> 看。</> : null}
          {ai.failed ? <>{ai.done ? ' ' : ''}有 {ai.failed} 道没生成出来，可以在错题本里逐题点「生成错因分析」再试。</> : null}
        </p>
      )}
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="card card-pad">
      <div className="small muted">{label}</div>
      <div className="stat-num">{value}</div>
    </div>
  );
}
