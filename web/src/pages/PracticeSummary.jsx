import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../api.js';
import { Alert, Loading, PageHead } from '../components/ui.jsx';

const TIER_STYLE = {
  已掌握: 'ok',
  待巩固: 'warn',
  薄弱: 'danger',
  未测: 'gray',
};

export default function PracticeSummary() {
  const { attemptId } = useParams();
  const navigate = useNavigate();
  const [sum, setSum] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get(`/practice/${attemptId}/summary`).then(setSum).catch((e) => setError(e.message));
  }, [attemptId]);

  async function drill(tagId) {
    setBusy(true); setError('');
    try {
      const r = await post('/practice/drill', { courseCode: sum.attempt.courseCode, tagId });
      navigate(`/app/practice/${r.attemptId}/run`);
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
        <Link className="btn" to="/app/practice/new">再练一轮</Link>
        <Link className="btn ghost" to="/app">回到首页</Link>
      </div>
    </>
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
