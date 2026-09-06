import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Alert, Loading, PageHead } from '../components/ui.jsx';

export default function UserHome() {
  const { user } = useAuth();
  const [courses, setCourses] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/courses').then((r) => setCourses(r.courses)).catch((e) => setError(e.message));
  }, []);

  return (
    <>
      <PageHead title={`你好，${user?.username}`} desc="选择课程开始练习" />
      {error ? <Alert>{error}</Alert> : null}
      {!courses ? <Loading /> : (
        <div className="grid-cards">
          {courses.map((c) => (
            <div className="card card-pad" key={c.course_code}>
              <div className="spread" style={{ marginBottom: 8 }}>
                <h2 style={{ fontSize: 16 }}>{c.course_name}</h2>
                <span className="badge info">{c.course_code}</span>
              </div>
              <p className="small muted" style={{ marginTop: 0 }}>
                考试时长 {c.time_limit_minutes} 分钟 · 满分 {c.total_score} 分
              </p>
              <p className="small">
                可用真题 <strong>{c.published_exams}</strong> 套 ·
                题目 <strong>{c.published_questions}</strong> 道
              </p>
              <div className="row" style={{ marginTop: 12 }}>
                <Link className="btn sm" to="/app/exam/new">模拟考试</Link>
                <Link className="btn ghost sm" to="/app/history">历史记录</Link>
                <button className="btn ghost sm" disabled title="学习模块将在下一阶段开放">专项学习</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 24 }}>
模拟考试与客观题判分已经可用。作文需要 AI 批改，专项练习、错题本与能力评估还在开发中。
      </p>
    </>
  );
}
