import { useEffect, useState } from 'react';
import { get } from '../../api.js';
import { Alert, Empty, Loading, PageHead } from '../../components/ui.jsx';

const TIER_STYLE = { 已掌握: 'ok', 待巩固: 'warn', 薄弱: 'danger', 未测: 'gray' };

export default function Students() {
  const [rows, setRows] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/admin/stats/students').then((r) => setRows(r.students)).catch((e) => setError(e.message));
  }, []);

  function open(id) {
    if (detail?.user?.id === id) { setDetail(null); return; }
    setDetail({ loading: true });
    get(`/admin/stats/students/${id}`).then(setDetail).catch((e) => setError(e.message));
  }

  if (error) return <Alert>{error}</Alert>;
  if (!rows) return <Loading />;

  return (
    <>
      <PageHead title="学员学情" desc="每个账号的练习量、成绩与待订正错题" />

      {rows.length === 0 ? <Empty>还没有学员账号</Empty> : (
        <div className="card" style={{ overflowX: 'auto', marginBottom: 16 }}>
          <table className="table responsive">
            <thead>
              <tr>
                <th>账号</th><th>模考</th><th>客观题均分</th><th>最好成绩</th>
                <th>练习</th><th>作答题数</th><th>待订正</th><th>最近活动</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((s) => (
                <tr key={s.id}>
                  <td data-label="账号">
                    <strong>{s.username}</strong>
                    {s.disabled ? <span className="badge danger" style={{ marginLeft: 6 }}>已停用</span> : null}
                  </td>
                  <td data-label="模考">{s.exam_count}</td>
                  <td data-label="客观题均分">{s.avg_objective ?? '—'}</td>
                  <td data-label="最好成绩">{s.best_objective ?? '—'}</td>
                  <td data-label="练习">{s.practice_count}</td>
                  <td data-label="作答题数">{s.answered}</td>
                  <td data-label="待订正">
                    {s.wrong_open > 0
                      ? <span className="badge warn">{s.wrong_open}</span>
                      : <span className="faint">—</span>}
                  </td>
                  <td data-label="最近活动">
                    <span className="small muted">{s.last_activity || s.last_login_at || '从未使用'}</span>
                  </td>
                  <td data-label="">
                    <button className="btn ghost sm" onClick={() => open(s.id)}>
                      {detail?.user?.id === s.id ? '收起' : '详情'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail?.loading ? <Loading /> : detail?.user ? (
        <div className="card card-pad">
          <h2 style={{ fontSize: 16, marginBottom: 10 }}>{detail.user.username} 的掌握情况</h2>
          <div className="row" style={{ marginBottom: 12 }}>
            {Object.entries(detail.tierCount).map(([tier, n]) => (
              <span key={tier} className={`badge ${TIER_STYLE[tier] || 'gray'}`}>{tier} {n}</span>
            ))}
            {Object.keys(detail.tierCount).length === 0 ? (
              <span className="small muted">还没有作答记录</span>
            ) : null}
          </div>
          <div className="row" style={{ marginBottom: 16 }}>
            {detail.mastery.map((m) => (
              <span key={m.name} className="tag" title={m.tier}>
                {m.name} <b>{m.correct}/{m.total}</b>
              </span>
            ))}
          </div>

          <h3 style={{ fontSize: 14, marginBottom: 8 }}>最近记录</h3>
          <div style={{ overflowX: 'auto' }}>
            <table className="table responsive">
              <thead>
                <tr><th>类型</th><th>状态</th><th>客观题</th><th>开始时间</th><th>用时</th></tr>
              </thead>
              <tbody>
                {detail.attempts.map((a) => (
                  <tr key={a.attempt_id}>
                    <td data-label="类型">
                      {a.mode === 'EXAM' ? '模考' : `练习·${a.practice_stage || ''}`}
                    </td>
                    <td data-label="状态">{a.status}</td>
                    <td data-label="客观题">{a.objective_score ?? '—'}</td>
                    <td data-label="开始时间"><span className="small muted">{a.started_at}</span></td>
                    <td data-label="用时">
                      {a.duration_seconds ? `${Math.round(a.duration_seconds / 60)} 分钟` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}
