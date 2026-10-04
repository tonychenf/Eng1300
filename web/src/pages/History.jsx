import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { Alert, Empty, Loading, PageHead } from '../components/ui.jsx';
import { useSubject } from '../subject.jsx';
import { formatBeijing } from '../lib/time.js';

// 成绩一栏：主观题没批完时只说客观题；批完了是总分。分母是这张卷的满分（服务端按上卷的题现加），
// 以前写死"/ 70"——那是英语的客观题满分，生化的卷子照它显示全错。
function scoreText(a) {
  if (a.status === '进行中' || a.objective_score === null) return '—';
  if (a.pending_ai > 0) return `客观题 ${a.objective_score} 分，主观题待批改`;
  return `${a.total_score ?? a.objective_score} / ${a.max_score}`;
}

export default function History() {
  const { path, courses } = useSubject();
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/history').then((r) => setRows(r.attempts)).catch((e) => setError(e.message));
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!rows) return <Loading />;

  // 接口是跨学科的、练习和模考都返回（mode 区分，m4-smoke 断着）。这一页在某个学科下、叫"历史记录：
  // 每次模考"，所以只列本学科的模考。以前全列：练习会话也在里面，"继续作答"点进去是模考作答页。
  const mine = new Set((courses || []).map((co) => co.course_code));
  const exams = rows.filter((a) => a.mode === 'EXAM' && mine.has(a.course_code));

  return (
    <>
      <PageHead title="历史记录" desc="每次模考的成绩与用时"
        actions={<Link className="btn sm" to={path('/exam/new')}>新的模考</Link>} />

      {exams.length === 0 ? <Empty>还没有考过，去开一套试试</Empty> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table responsive">
            <thead>
              <tr><th>时间</th><th>难度</th><th>状态</th><th>成绩</th><th>用时</th><th></th></tr>
            </thead>
            <tbody>
              {exams.map((a) => (
                <tr key={a.attempt_id}>
                  <td data-label="时间">{formatBeijing(a.started_at)}</td>
                  <td data-label="难度">{a.difficulty}</td>
                  <td data-label="状态">
                    {a.status === '进行中'
                      ? <span className="badge warn">进行中</span>
                      : <span className="badge ok">已交卷</span>}
                  </td>
                  <td data-label="成绩">{scoreText(a)}</td>
                  <td data-label="用时">
                    {a.duration_seconds ? `${Math.round(a.duration_seconds / 60)} 分钟` : '—'}
                  </td>
                  <td data-label="">
                    {a.status === '进行中'
                      ? <Link className="btn sm" to={path(`/exam/${a.attempt_id}/take`)}>继续作答</Link>
                      : <Link className="btn ghost sm" to={path(`/exam/${a.attempt_id}/report`)}>看报告</Link>}
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
