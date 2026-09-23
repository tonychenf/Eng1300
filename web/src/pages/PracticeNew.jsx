import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post } from '../api.js';
import { Alert, Loading, PageHead } from '../components/ui.jsx';
import { useSubject } from '../subject.jsx';

export default function PracticeNew() {
  const { path, courses: subjectCourses } = useSubject();
  const navigate = useNavigate();
  const [courseCode, setCourseCode] = useState('');
  const [types, setTypes] = useState([]);
  const [picked, setPicked] = useState([]);   // 空数组表示不限题型
  const [scope, setScope] = useState(null);
  const [active, setActive] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // 依赖里必须带 subjectCourses：切学科时组件不会重新挂载（在路由树里位置没变），
  // 依赖写空数组的话这段不会重跑，courseCode 会一直停在上一个学科的课程上。
  useEffect(() => {
    if (subjectCourses.length === 1) setCourseCode(subjectCourses[0].course_code);
  }, [subjectCourses]);

  useEffect(() => {
    if (!courseCode) return;
    get(`/practice/section-types?courseCode=${courseCode}`)
      .then((r) => setTypes(r.sectionTypes)).catch(() => {});
    get(`/practice/active?courseCode=${courseCode}`)
      .then((r) => setActive(r.active)).catch(() => {});
  }, [courseCode]);

  // 题型选择一变就刷新范围预览，让人看到这次能练多少
  useEffect(() => {
    if (!courseCode) { setScope(null); return; }
    const qs = new URLSearchParams({ courseCode });
    if (picked.length) qs.set('sectionTypes', picked.join(','));
    setScope(null);
    get(`/practice/scope?${qs}`).then(setScope).catch((e) => setError(e.message));
  }, [courseCode, picked]);

  function toggle(t) {
    setPicked((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  }

  async function start() {
    setBusy(true); setError('');
    try {
      const r = await post('/practice/start', {
        courseCode,
        sectionTypes: picked.length ? picked : undefined,
      });
      navigate(path(`/practice/${r.attemptId}/run`));
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  if (!subjectCourses) return <Loading />;
  const canStart = Boolean(courseCode) && scope && scope.questionCount > 0;

  return (
    <>
      <PageHead
        title="专项练习"
        desc="不限时。先每个考点摸一道找出薄弱面，再按掌握度反复强化"
      />

      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}

      {active ? (
        <div className="card card-pad" style={{ marginBottom: 16, borderColor: 'var(--primary)' }}>
          <div className="spread">
            <div>
              <strong className="small">有一次练习还没结束</strong>
              <p className="tiny muted" style={{ margin: '4px 0 0' }}>
                {active.practice_stage} · 已做 {active.asked} 题 · 开始于 {active.started_at}
              </p>
            </div>
            <Link className="btn sm" to={path(`/practice/${active.attempt_id}/run`)}>继续</Link>
          </div>
        </div>
      ) : null}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        {/* 只有一门课时不摆下拉框——只有一个选项的选择器是白让人点一下 */}
        {subjectCourses.length > 1 ? (
          <div className="field">
            <label htmlFor="course">课程</label>
            <select id="course" className="input" value={courseCode}
              onChange={(e) => setCourseCode(e.target.value)}>
              <option value="">请选择</option>
              {subjectCourses.map((c) => (
                <option key={c.course_code} value={c.course_code}>{c.course_name}</option>
              ))}
            </select>
          </div>
        ) : null}

        <div className="field" style={{ marginBottom: 8 }}>
          <label>题型范围</label>
          <p className="tiny muted" style={{ marginTop: 0 }}>
            都不选表示不限题型。写作题需要 AI 批改，练习里不出。
          </p>
          <div className="row">
            {types.map((t) => (
              <button
                key={t.section_type}
                type="button"
                className={`tag${picked.includes(t.section_type) ? '' : ''}`}
                onClick={() => toggle(t.section_type)}
                style={{
                  cursor: 'pointer', minHeight: 36, border: '1px solid',
                  borderColor: picked.includes(t.section_type) ? 'var(--primary)' : 'var(--line)',
                  background: picked.includes(t.section_type) ? 'var(--primary-tint)' : '#fff',
                  color: picked.includes(t.section_type) ? 'var(--primary)' : 'var(--ink-2)',
                }}
              >
                {t.section_type} <b>{t.question_count}</b>
              </button>
            ))}
          </div>
        </div>
      </div>

      {courseCode ? (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, marginBottom: 8 }}>本次范围</h2>
          {!scope ? <Loading label="统计中" /> : scope.questionCount === 0 ? (
            <Alert>所选范围内没有可用题目，请少选几个题型或换成不限。</Alert>
          ) : (
            <>
              <div className="row" style={{ marginBottom: 10 }}>
                <span><span className="tiny muted">可用题目 </span><strong>{scope.questionCount}</strong></span>
                <span><span className="tiny muted">覆盖考点 </span><strong>{scope.knowledgePoints.length}</strong></span>
              </div>
              <div className="row">
                {scope.knowledgePoints.map((k) => (
                  <span key={k.tag_id} className="tag">{k.name} <b>{k.question_count}</b></span>
                ))}
              </div>
            </>
          )}
        </div>
      ) : null}

      <div className="sticky-actions">
        <button className="btn" onClick={start} disabled={!canStart || busy}>
          {busy ? '准备中…' : '开始练习'}
        </button>
      </div>
    </>
  );
}
