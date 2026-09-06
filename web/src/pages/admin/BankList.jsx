import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../../api.js';
import { Alert, Empty, Loading, PageHead, StatusBadge } from '../../components/ui.jsx';

const STATUSES = ['', '待校对', '已发布'];

export default function BankList() {
  const [exams, setExams] = useState(null);
  const [courses, setCourses] = useState([]);
  const [courseCode, setCourseCode] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    get('/courses').then((r) => setCourses(r.courses)).catch(() => {});
  }, []);

  useEffect(() => {
    const qs = new URLSearchParams();
    if (courseCode) qs.set('courseCode', courseCode);
    if (status) qs.set('status', status);
    setExams(null);
    get(`/admin/bank/exams${qs.toString() ? `?${qs}` : ''}`)
      .then((r) => setExams(r.exams))
      .catch((e) => setError(e.message));
  }, [courseCode, status]);

  return (
    <>
      <PageHead title="试卷与题库" desc="校对预解析结果，确认无误后发布整卷" />

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="row">
          <select className="input" style={{ width: 'auto', minWidth: 200 }}
            value={courseCode} onChange={(e) => setCourseCode(e.target.value)}>
            <option value="">全部课程</option>
            {courses.map((c) => (
              <option key={c.course_code} value={c.course_code}>
                {c.course_name}（{c.course_code}）
              </option>
            ))}
          </select>
          <select className="input" style={{ width: 'auto', minWidth: 140 }}
            value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s || '全部状态'}</option>)}
          </select>
        </div>
      </div>

      {error ? <Alert>{error}</Alert> : null}
      {!exams ? <Loading /> : exams.length === 0 ? <Empty>没有符合条件的试卷</Empty> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table responsive">
            <thead>
              <tr>
                <th>试卷</th><th>课程</th><th>题量</th><th>已校对</th>
                <th>存疑</th><th>状态</th><th></th>
              </tr>
            </thead>
            <tbody>
              {exams.map((e) => (
                <tr key={e.exam_id}>
                  <td data-label="试卷">{e.year} 年 {e.month} 月</td>
                  <td data-label="课程">{e.course_name}</td>
                  <td data-label="题量">{e.question_count}</td>
                  <td data-label="已校对">{e.reviewed_count} / {e.question_count}</td>
                  <td data-label="存疑">
                    {e.open_notes > 0
                      ? <span className="badge danger">{e.open_notes}</span>
                      : <span className="faint">—</span>}
                  </td>
                  <td data-label="状态"><StatusBadge status={e.status} /></td>
                  <td data-label="">
                    <Link className="btn ghost sm" to={`/admin/bank/${e.exam_id}`}>校对</Link>
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
