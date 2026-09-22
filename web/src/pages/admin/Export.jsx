import { useEffect, useState } from 'react';
import { get, getToken } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

// 导出接口带 Authorization 头，普通链接下载带不上，所以先 fetch 成 blob 再触发保存
async function download(path, fallbackName, onError) {
  try {
    const res = await fetch(`/api${path}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error(`导出失败（${res.status}）`);
    const disp = res.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename="([^"]+)"/);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = m ? m[1] : fallbackName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    onError(e.message);
  }
}

export default function Export() {
  const [courses, setCourses] = useState([]);
  const [students, setStudents] = useState([]);
  const [courseCode, setCourseCode] = useState('');
  const [userId, setUserId] = useState('');
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    get('/courses').then((r) => setCourses(r.courses)).catch(() => {});
    get('/admin/stats/students').then((r) => setStudents(r.students)).catch(() => {});
    get('/admin/stats/overview').then((r) => setOverview(r.overview)).catch((e) => setError(e.message));
  }, []);

  async function run(kind) {
    setBusy(kind); setError('');
    if (kind === 'bank') {
      await download(
        `/admin/stats/export/bank${courseCode ? `?courseCode=${courseCode}` : ''}`,
        'bank.json', setError
      );
    } else {
      await download(
        `/admin/stats/export/records${userId ? `?userId=${userId}` : ''}`,
        'records.json', setError
      );
    }
    setBusy('');
  }

  return (
    <>
      <PageHead title="数据导出" desc="题库与作答记录导出为 JSON，用于备份或离线分析" />
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}

      {!overview ? <Loading /> : (
        <div className="grid-cards" style={{ marginBottom: 20 }}>
          <Stat label="学员账号" value={overview.students}
            sub={overview.disabled_students ? `其中 ${overview.disabled_students} 个已停用` : '全部正常'} />
          <Stat label="已交模考" value={overview.exams_done} sub={`练习 ${overview.practices} 次`} />
          <Stat label="累计作答" value={overview.answers} sub={`待订正错题 ${overview.wrong_open}`} />
          <Stat label="可抽题目" value={overview.questions_live}
            sub={`另有 ${overview.questions_held} 道存疑不参与组卷`} />
        </div>
      )}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>题库</h2>
        <p className="tiny muted" style={{ marginTop: 0 }}>
          整卷结构、题目、选项、答案、考点标签与存疑记录。
        </p>
        <div className="row">
          <select className="input" style={{ width: 'auto', minWidth: 180 }}
            value={courseCode} onChange={(e) => setCourseCode(e.target.value)}>
            <option value="">全部课程</option>
            {courses.map((c) => (
              <option key={c.course_code} value={c.course_code}>{c.course_name}</option>
            ))}
          </select>
          <button className="btn" onClick={() => run('bank')} disabled={Boolean(busy)}>
            {busy === 'bank' ? '导出中…' : '导出题库'}
          </button>
        </div>
      </div>

      <div className="card card-pad">
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>作答记录</h2>
        <p className="tiny muted" style={{ marginTop: 0 }}>
          模考与练习会话、逐题作答、错题本、考点掌握度。
        </p>
        <div className="row">
          <select className="input" style={{ width: 'auto', minWidth: 180 }}
            value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">全部学员</option>
            {students.map((s) => (
              <option key={s.id} value={s.id}>{s.username}</option>
            ))}
          </select>
          <button className="btn" onClick={() => run('records')} disabled={Boolean(busy)}>
            {busy === 'records' ? '导出中…' : '导出作答记录'}
          </button>
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, sub }) {
  return (
    <div className="card card-pad">
      <div className="small muted">{label}</div>
      <div className="stat-num">{value}</div>
      <div className="tiny faint">{sub}</div>
    </div>
  );
}
