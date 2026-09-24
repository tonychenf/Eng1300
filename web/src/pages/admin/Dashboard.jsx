import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

export default function Dashboard() {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/admin/bank/stats').then(setStats).catch((e) => setError(e.message));
  }, []);

  if (error) return <Alert>{error}</Alert>;
  if (!stats) return <Loading />;

  const totalQuestions = stats.byType.reduce((n, r) => n + r.total, 0);
  const publishedQuestions = stats.byType.reduce((n, r) => n + (r.published || 0), 0);
  const totalExams = stats.byCourse.reduce((n, r) => n + r.exam_count, 0);
  const publishedExams = stats.byCourse.reduce((n, r) => n + (r.published_exams || 0), 0);
  // §6.4.10：缺答案题数是内容建设进度的核心指标，看板上必须有。
  // 待核（答案在但来自 AI）和缺答案（根本没有）要分开显示——合成一个数的话，
  // "还剩多少要录"和"还剩多少要核"是两件工作量差很远的事。
  const byAnswer = stats.byAnswerState || [];
  const noAnswer = byAnswer.reduce((n, r) => n + (r.no_answer || 0), 0);
  const unreviewed = byAnswer.reduce((n, r) => n + (r.unreviewed || 0), 0);

  return (
    <>
      <PageHead title="题库总览" desc="预解析材料的入库与校对进度" />

      <div className="grid-cards" style={{ marginBottom: 20 }}>
        <Stat label="试卷总数" value={totalExams} sub={`已发布 ${publishedExams} 套`} />
        <Stat label="题目总数" value={totalQuestions} sub={`已发布 ${publishedQuestions} 题`} />
        <Stat label="考点标签" value={stats.byTag.length} sub="覆盖的知识点数量" />
        <Stat
          label="待处理存疑"
          value={stats.unresolvedNotes}
          sub={stats.unresolvedNotes ? '处理完才能发布整卷' : '全部已处理'}
          danger={stats.unresolvedNotes > 0}
        />
        <Stat
          label="缺答案"
          value={noAnswer}
          sub={noAnswer ? '还没有标准答案，不参与抽题' : '每道题都有答案'}
          danger={noAnswer > 0}
        />
        <Stat
          label="待人工核对"
          value={unreviewed}
          sub={unreviewed ? '答案来自 AI，核过才能发布' : '没有待核的答案'}
          danger={unreviewed > 0}
        />
      </div>

      {byAnswer.length > 1 ? (
        <div className="card card-pad" style={{ marginBottom: 20 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>按学科的答案进度</h2>
          <div style={{ overflowX: 'auto' }}>
            <table className="table responsive">
              <thead>
                <tr><th>学科</th><th>已确认</th><th>待核</th><th>缺答案</th></tr>
              </thead>
              <tbody>
                {byAnswer.map((r) => (
                  <tr key={r.subject_code}>
                    <td data-label="学科">{r.subject_name}</td>
                    <td data-label="已确认">{r.confirmed}</td>
                    <td data-label="待核">{r.unreviewed || <span className="faint">—</span>}</td>
                    <td data-label="缺答案">{r.no_answer || <span className="faint">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <div className="spread" style={{ marginBottom: 12 }}>
          <h2 style={{ fontSize: 16 }}>按课程</h2>
          <Link className="btn ghost sm" to="/admin/bank">进入题库</Link>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="table responsive">
            <thead>
              <tr><th>课程</th><th>试卷数</th><th>已发布</th></tr>
            </thead>
            <tbody>
              {stats.byCourse.map((r) => (
                <tr key={r.course_code}>
                  <td data-label="课程">{r.course_name}（{r.course_code}）</td>
                  <td data-label="试卷数">{r.exam_count}</td>
                  <td data-label="已发布">{r.published_exams || 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card card-pad">
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>考点分布</h2>
        <div className="row">
          {stats.byTag.map((t) => (
            <span key={t.name} className="tag">
              {t.name}<b>{t.total}</b>
            </span>
          ))}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, sub, danger }) {
  return (
    <div className="card card-pad">
      <div className="small muted">{label}</div>
      <div className="stat-num" style={danger ? { color: 'var(--danger)' } : undefined}>{value}</div>
      <div className="tiny faint">{sub}</div>
    </div>
  );
}
