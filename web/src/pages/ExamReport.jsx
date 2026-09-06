import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { get, post } from '../api.js';
import { Alert, Loading, PageHead } from '../components/ui.jsx';
import { Question, OptionBank, sharedOptionsOf } from '../components/questions.jsx';

// 不足一分钟就显示秒，免得刚交卷的报告写着"用时 0 分钟"
function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return `${s} 秒`;
  return `${Math.round(s / 60)} 分钟`;
}

export default function ExamReport() {
  const { attemptId } = useParams();
  const location = useLocation();
  const [rep, setRep] = useState(null);
  const [error, setError] = useState('');
  const [openSection, setOpenSection] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiMsg, setAiMsg] = useState(null);

  useEffect(() => {
    get(`/attempts/${attemptId}/report`).then(setRep).catch((e) => setError(e.message));
  }, [attemptId]);

  async function runAi() {
    setAiBusy(true); setAiMsg(null);
    try {
      const r = await post(`/ai/attempts/${attemptId}/run`);
      const parts = [];
      if (r.essay?.status === 'graded') parts.push(`作文 ${r.essay.total} 分`);
      else if (r.essay?.status === 'blank') parts.push('作文未作答，记 0 分');
      else if (r.essay?.status === 'failed') parts.push('作文批改失败，可稍后重试');
      if (r.wrongItems?.done) parts.push(`${r.wrongItems.done} 道错题已生成解析`);
      if (r.wrongItems?.failed) parts.push(`${r.wrongItems.failed} 道错题解析失败`);
      const ok = r.essay?.status !== 'failed' && !r.wrongItems?.failed;
      setAiMsg({ kind: ok ? 'success' : 'error', text: parts.join('，') || '没有需要处理的内容' });
      setRep(await get(`/attempts/${attemptId}/report`));
    } catch (e) {
      setAiMsg({ kind: 'error', text: `AI 暂时不可用：${e.message}。客观题成绩不受影响。` });
    } finally { setAiBusy(false); }
  }

  if (error) return <Alert>{error}</Alert>;
  if (!rep) return <Loading label="正在生成报告" />;

  const { attempt, sectionScores, history, knowledgePoints, sections } = rep;
  const objectiveMax = sectionScores.reduce((n, s) => n + (s.pendingAi ? 0 : s.maxScore), 0);
  const pct = objectiveMax ? Math.round((attempt.objectiveScore / objectiveMax) * 100) : 0;
  const weak = knowledgePoints.filter((k) => k.correct / k.total < 0.6);

  return (
    <>
      <PageHead
        title="成绩报告"
        desc={`${attempt.difficulty} · 用时 ${formatDuration(attempt.durationSeconds)}`}
        actions={<Link className="btn ghost sm" to="/app/history">历史记录</Link>}
      />

      {location.state?.auto ? (
        <div style={{ marginBottom: 12 }}><Alert kind="info">考试时间到，系统已自动交卷。</Alert></div>
      ) : null}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="spread">
          <div>
            <div className="small muted">客观题得分</div>
            <div className="score-big">
              {attempt.objectiveScore}
              <span className="small muted" style={{ fontWeight: 400 }}> / {objectiveMax}</span>
            </div>
            <div className="tiny muted">正确率 {pct}%</div>
          </div>
          {attempt.pendingAi > 0 ? (
            <span className="badge gray">作文 30 分待 AI 批改</span>
          ) : null}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={runAi} disabled={aiBusy}>
            {aiBusy ? 'AI 处理中…' : attempt.pendingAi > 0 ? '批改作文并生成错题解析' : '重新生成 AI 解析'}
          </button>
          <Link className="btn ghost sm" to="/app/wrongbook">错题本</Link>
          <Link className="btn ghost sm" to="/app/assessment">能力评估</Link>
        </div>
        {aiMsg ? (
          <div style={{ marginTop: 10 }}><Alert kind={aiMsg.kind}>{aiMsg.text}</Alert></div>
        ) : null}
        {history.attempts > 1 ? (
          <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
            你已完成 {history.attempts} 次模考，客观题平均 {history.avgObjective?.toFixed(1)} 分。
          </p>
        ) : null}
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, marginBottom: 12 }}>各部分得分</h2>
        <div className="stack">
          {sectionScores.map((s) => (
            <div key={s.sectionOrd}>
              <div className="spread" style={{ marginBottom: 4 }}>
                <span className="small">第 {s.sectionOrd} 部分 · {s.sectionType}</span>
                <span className="small">
                  {s.pendingAi ? <span className="muted">待批改</span>
                    : <><strong>{s.score}</strong> <span className="muted">/ {s.maxScore}</span></>}
                </span>
              </div>
              <div className={`bar${s.pendingAi ? '' : s.score / s.maxScore >= 0.6 ? ' ok' : ' warn'}`}>
                <span style={{ width: `${s.pendingAi ? 0 : (s.score / s.maxScore) * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      </div>

      {weak.length ? (
        <div className="card card-pad" style={{ marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, marginBottom: 4 }}>本卷薄弱考点</h2>
          <p className="tiny muted" style={{ marginTop: 0 }}>正确率低于 60% 的考点，按由低到高排列。</p>
          <div className="row">
            {weak.map((k) => (
              <span key={k.name} className="tag">
                {k.name} <b>{k.correct}/{k.total}</b>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <h2 style={{ fontSize: 16, marginBottom: 12 }}>逐题解析</h2>
      {sections.map((s) => {
        const shared = sharedOptionsOf(s);
        const open = openSection === s.sectionOrd;
        const wrong = s.questions.filter((q) => q.isCorrect === 0).length;
        return (
          <div className="card" key={s.sectionOrd} style={{ marginBottom: 12 }}>
            <button
              onClick={() => setOpenSection(open ? null : s.sectionOrd)}
              style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                width: '100%', minHeight: 56, padding: '0 16px',
                border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span>
                <strong className="small">第 {s.sectionOrd} 部分 · {s.sectionType}</strong>
                {wrong > 0 ? <span className="badge danger" style={{ marginLeft: 8 }}>错 {wrong}</span> : null}
              </span>
              <span className="tiny muted">{open ? '收起' : '展开'}</span>
            </button>

            {open ? (
              <div style={{ borderTop: '1px solid var(--line)' }}>
                {s.passageText || s.writingPrompt ? (
                  <details style={{ padding: '12px 16px 0' }}>
                    <summary className="small muted" style={{ cursor: 'pointer', minHeight: 32 }}>
                      查看原文{s.passageTitle ? `：${s.passageTitle}` : ''}
                    </summary>
                    <div className="passage" style={{ marginTop: 8 }}>
                      {s.passageText || s.writingPrompt}
                    </div>
                  </details>
                ) : null}
                {shared ? <div style={{ padding: '12px 16px 0' }}><OptionBank options={shared} /></div> : null}
                {s.questions.map((q) => (
                  <Question key={q.questionId} q={q} compact={Boolean(shared)} review />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}

      <div className="sticky-actions">
        <Link className="btn" to="/app/exam/new">再考一次</Link>
        <Link className="btn ghost" to="/app">回到首页</Link>
      </div>
    </>
  );
}
