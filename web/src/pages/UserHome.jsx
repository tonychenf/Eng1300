import { useEffect, useState } from 'react';
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
                <button className="btn sm" disabled title="模拟考试将在下一阶段开放">模拟考试</button>
                <button className="btn ghost sm" disabled title="学习模块将在下一阶段开放">专项学习</button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="small muted" style={{ marginTop: 24 }}>
        当前为服务器与账号权限的试运行版本，模拟考试与学习模块正在开发中。
      </p>
    </>
  );
}
