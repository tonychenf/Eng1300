import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { Alert, Empty, Loading, PageHead } from '../components/ui.jsx';

export default function History() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/history').then((r) => setRows(r.attempts)).catch((e) => setError(e.message));
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!rows) return <Loading />;

  return (
    <>
      <PageHead title="历史记录" desc="每次模考的成绩与用时"
        actions={<Link className="btn sm" to="/app/exam/new">新的模考</Link>} />

      {rows.length === 0 ? <Empty>还没有考过，去开一套试试</Empty> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table responsive">
            <thead>
              <tr><th>时间</th><th>难度</th><th>状态</th><th>客观题</th><th>用时</th><th></th></tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.attempt_id}>
                  <td data-label="时间">{a.started_at}</td>
                  <td data-label="难度">{a.difficulty}</td>
                  <td data-label="状态">
                    {a.status === '进行中'
                      ? <span className="badge warn">进行中</span>
                      : <span className="badge ok">已交卷</span>}
                  </td>
                  <td data-label="客观题">
                    {a.objective_score === null ? '—' : `${a.objective_score} / 70`}
                  </td>
                  <td data-label="用时">
                    {a.duration_seconds ? `${Math.round(a.duration_seconds / 60)} 分钟` : '—'}
                  </td>
                  <td data-label="">
                    {a.status === '进行中'
                      ? <Link className="btn sm" to={`/app/exam/${a.attempt_id}/take`}>继续作答</Link>
                      : <Link className="btn ghost sm" to={`/app/exam/${a.attempt_id}/report`}>看报告</Link>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
