import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post } from '../api.js';
import { Alert, Loading, PageHead } from '../components/ui.jsx';
import { useSubject } from '../subject.jsx';

const DIFFICULTIES = [
  { key: '随机', desc: '不看历史，纯随机组卷' },
  { key: '简单', desc: '偏向你做得好的考点' },
  { key: '正常', desc: '难易均衡' },
  { key: '困难', desc: '偏向你薄弱的考点' },
];

export default function ExamNew() {
  const { path, courses: subjectCourses } = useSubject();
  const navigate = useNavigate();
  const [courseCode, setCourseCode] = useState('');
  const [difficulty, setDifficulty] = useState('随机');
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 依赖里必须带 subjectCourses：切学科时组件不会重新挂载（在路由树里位置没变），
  // 依赖写空数组的话这段不会重跑，courseCode 会一直停在上一个学科的课程上。
  useEffect(() => {
    if (subjectCourses.length === 1) setCourseCode(subjectCourses[0].course_code);
  }, [subjectCourses]);

  async function generate() {
    setBusy(true); setError(''); setPreview(null);
    try {
      setPreview(await post('/exams/generate', { courseCode, difficulty }));
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  if (!subjectCourses) return <Loading />;
  const course = subjectCourses.find((c) => c.course_code === courseCode);

  return (
    <>
      <PageHead title="开始模拟考试" desc="按真题结构随机组一套新卷，考点尽量不重复" />
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}

      {preview ? (
        <>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="spread" style={{ marginBottom: 12 }}>
              <h2 style={{ fontSize: 16 }}>本卷构成</h2>
              <span className="badge info">{preview.difficulty}</span>
            </div>
            <div className="row" style={{ marginBottom: 12 }}>
              <Facet label="题量" value={`${preview.questionCount} 题`} />
              <Facet label="满分" value={`${preview.totalScore} 分`} />
              <Facet label="时长" value={`${preview.timeLimitMinutes} 分钟`} />
              <Facet label="覆盖考点" value={`${preview.knowledgePointCount} 个`} />
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="table responsive">
                <thead>
                  <tr><th>部分</th><th>题型</th><th>题量</th><th>每题分</th><th>小计</th></tr>
                </thead>
                <tbody>
                  {preview.sections.map((s) => (
                    <tr key={s.sectionOrd}>
                      <td data-label="部分">第 {s.sectionOrd} 部分</td>
                      <td data-label="题型">{s.sectionType}</td>
                      <td data-label="题量">{s.questionCount}</td>
                      <td data-label="每题分">{s.scorePerQuestion}</td>
                      <td data-label="小计">{s.totalScore}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.warnings?.length ? (
              <div style={{ marginTop: 12 }}>
                <Alert kind="info">
                  {preview.warnings.map((w, i) => <div key={i}>{w}</div>)}
                </Alert>
              </div>
            ) : null}
          </div>

          <Alert kind="info">
            点「开始作答」后倒计时立即开始，按真实时间流逝计算，关掉页面也不会暂停。
          </Alert>

          <div className="sticky-actions">
            <button className="btn" onClick={() => navigate(path(`/exam/${preview.attemptId}/take`))}>
              开始作答
            </button>
            <button className="btn ghost" onClick={() => setPreview(null)}>重新组卷</button>
          </div>
        </>
      ) : (
        <>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            {/* 只有一门课时不摆下拉框——只有一个选项的选择器是白让人点一下 */}
            {subjectCourses.length > 1 ? (
              <div className="field">
                <label htmlFor="course">课程</label>
                <select id="course" className="input" value={courseCode}
                  onChange={(e) => setCourseCode(e.target.value)}>
                  <option value="">请选择</option>
                  {subjectCourses.map((c) => (
                    <option key={c.course_code} value={c.course_code}>
                      {c.course_name}（可用 {c.published_questions} 题）
                    </option>
                  ))}
                </select>
              </div>
            ) : course ? (
              <div className="field">
                <label>课程</label>
                <p className="small" style={{ margin: 0 }}>
                  {course.course_name}
                  <span className="muted">（可用 {course.published_questions} 题）</span>
                </p>
              </div>
            ) : null}

            <div className="field" style={{ marginBottom: 0 }}>
              <label>难度倾向</label>
              {DIFFICULTIES.map((d) => (
                <label key={d.key} className={`choice${difficulty === d.key ? ' picked' : ''}`}>
                  <input type="radio" name="difficulty" checked={difficulty === d.key}
                    onChange={() => setDifficulty(d.key)} />
                  <span>
                    <strong>{d.key}</strong>
                    <span className="small muted" style={{ marginLeft: 8 }}>{d.desc}</span>
                  </span>
                </label>
              ))}
              <p className="tiny muted" style={{ marginBottom: 0 }}>
                简单和困难要参考你的历史正确率，第一次考试时与随机没有区别。
              </p>
            </div>
          </div>

          <div className="sticky-actions">
            <button className="btn" onClick={generate} disabled={!course || busy}>
              {busy ? '组卷中…' : '生成试卷'}
            </button>
          </div>
        </>
      )}
    </>
  );
}

function Facet({ label, value }) {
  return (
    <span>
      <span className="tiny muted">{label} </span>
      <strong className="small">{value}</strong>
    </span>
  );
}
