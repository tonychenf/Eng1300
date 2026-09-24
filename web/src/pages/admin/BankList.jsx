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

      <p className="small" style={{ marginBottom: 12 }}>

        <Link className="btn ghost sm" to="/admin/bank/import">上传题库</Link>

      </p>

      {error ? <Alert>{error}</Alert> : null}
      {!exams ? <Loading /> : exams.length === 0 ? <Empty>没有符合条件的试卷</Empty> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table responsive">
            <thead>
              <tr>
                <th>内容组</th><th>课程</th><th>题量</th><th>已校对</th>
                <th>缺答案</th><th>存疑</th><th>状态</th><th></th>
              </tr>
            </thead>
            <tbody>
              {exams.map((e) => (
                <tr key={e.exam_id}>
                  {/* 显示名一律走 label（§6.4.2）：生化的内容组是教材章节，没有年月。
                      拼 "{year} 年 {month} 月" 的话生化会显示成 "0 年 0 月"。 */}
                  <td data-label="内容组">{e.label || e.title}</td>
                  <td data-label="课程">{e.course_name}</td>
                  <td data-label="题量">{e.question_count}</td>
                  <td data-label="已校对">{e.reviewed_count} / {e.question_count}</td>
                  <td data-label="缺答案">
                    {e.missing_answer_count > 0
                      ? <span className="badge warn">{e.missing_answer_count}</span>
                      : <span className="faint">—</span>}
                  </td>
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
