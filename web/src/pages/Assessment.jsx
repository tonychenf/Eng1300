import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../api.js';
import { Alert, Loading, PageHead } from '../components/ui.jsx';
import { SectionBars, TrendLine } from '../components/charts.jsx';

const TIER_ORDER = ['已掌握', '待巩固', '薄弱', '未测'];
const TIER_STYLE = { 已掌握: 'ok', 待巩固: 'warn', 薄弱: 'danger', 未测: 'gray' };

export default function Assessment() {
  const [courses, setCourses] = useState([]);
  const [courseCode, setCourseCode] = useState('');
  const [data, setData] = useState(null);
  const [ai, setAi] = useState(null);
  const [aiError, setAiError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/courses').then((r) => {
      setCourses(r.courses);
      if (r.courses.length) setCourseCode(r.courses[0].course_code);
    }).catch((e) => setError(e.message));
  }, []);

  const load = useCallback(() => {
    if (!courseCode) return;
    setData(null); setAi(null); setAiError('');
    get(`/assessment?courseCode=${courseCode}`).then(setData).catch((e) => setError(e.message));
  }, [courseCode]);

  useEffect(() => { load(); }, [load]);

  async function runAi() {
    setAiBusy(true); setAiError('');
    try {
      const r = await post('/ai/assessment', {
        courseCode,
        statPredicted: data?.statistical?.predicted ?? null,
      });
      setAi(r.ai);
    } catch (e) {
      setAiError(e.message);
    } finally { setAiBusy(false); }
  }

  if (error) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;

  const tierCount = data.tierCount || {};

  return (
    <>
      <PageHead
        title="能力评估"
        desc="统计预测与 AI 意见并列显示，互不覆盖"
        actions={courses.length > 1 ? (
          <select className="input" style={{ width: 'auto' }} value={courseCode}
            onChange={(e) => setCourseCode(e.target.value)}>
            {courses.map((c) => (
              <option key={c.course_code} value={c.course_code}>{c.course_name}</option>
            ))}
          </select>
        ) : null}
      />

      {!data.enoughData ? (
        <div style={{ marginBottom: 16 }}>
          <Alert kind="info">
            {data.message}。一次考试的预测没有参考价值，所以样本不足时不给分数。
          </Alert>
        </div>
      ) : (
        <>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="small muted">统计模型预测</div>
            <div className="score-big">
              {data.statistical.low} – {data.statistical.high}
              <span className="small muted" style={{ fontWeight: 400 }}> 分</span>
            </div>
            <p className="tiny muted" style={{ marginBottom: 0 }}>
              点估计 {data.statistical.predicted} 分，基于最近 {data.examCount} 次模考按时间衰减加权。
            </p>
          </div>

          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <h2 style={{ fontSize: 16, marginBottom: 4 }}>各部分得分率</h2>
            <p className="tiny muted" style={{ marginTop: 0 }}>越低的部分越该先补。</p>
            <SectionBars sections={data.statistical.sections} />
          </div>
        </>
      )}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, marginBottom: 4 }}>历次模考总分</h2>
        <TrendLine trend={data.trend} />
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, marginBottom: 10 }}>考点掌握度</h2>
        <div className="row" style={{ marginBottom: 12 }}>
          {TIER_ORDER.filter((t) => tierCount[t]).map((t) => (
            <span key={t} className={`badge ${TIER_STYLE[t]}`}>{t} {tierCount[t]}</span>
          ))}
        </div>
        <div className="row">
          {data.mastery.map((m) => (
            <span key={m.tagId} className="tag" title={`${m.tier}：做过 ${m.total} 题，对 ${m.correct} 题`}>
              {m.name} <b>{m.correct}/{m.total}</b>
            </span>
          ))}
        </div>
        {data.mastery.length === 0 ? (
          <p className="small muted" style={{ marginBottom: 0 }}>还没有作答记录。</p>
        ) : null}
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="spread" style={{ marginBottom: 8 }}>
          <h2 style={{ fontSize: 16 }}>AI 综合意见</h2>
          <button className="btn ghost sm" onClick={runAi} disabled={aiBusy || !courseCode}>
            {aiBusy ? '生成中…' : ai ? '重新生成' : '生成'}
          </button>
        </div>
        {aiError ? <Alert>{aiError}</Alert> : null}
        {!ai && !aiError ? (
          <p className="small muted" style={{ marginBottom: 0 }}>
            点「生成」让 AI 结合掌握度、错题分布和分数趋势给一份评估。统计预测不受它影响。
          </p>
        ) : null}
        {ai ? (
          <div className="stack">
            {ai.predictedLow !== null && ai.predictedHigh !== null ? (
              <div>
                <span className="tiny muted">AI 预测区间 </span>
                <strong>{ai.predictedLow} – {ai.predictedHigh} 分</strong>
              </div>
            ) : null}
            {ai.levelDesc ? <p className="small" style={{ margin: 0 }}>{ai.levelDesc}</p> : null}
            {ai.weakPoints?.length ? (
              <div className="row">
                <span className="tiny muted">优先补强</span>
                {ai.weakPoints.map((w) => <span key={w} className="tag">{w}</span>)}
              </div>
            ) : null}
            {ai.suggestions?.map((s, i) => (
              <div key={i} className="small" style={{ display: 'flex', gap: 8 }}>
                <span className="q-num" style={{ flexShrink: 0 }}>{i + 1}</span>
                <span>{s}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="sticky-actions">
        <Link className="btn" to="/app/exam/new">再考一次</Link>
        <Link className="btn ghost" to="/app/wrongbook">看错题本</Link>
      </div>
    </>
  );
}
