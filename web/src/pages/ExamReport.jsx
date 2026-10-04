import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { get, post } from '../api.js';
import { Alert, Loading, PageHead } from '../components/ui.jsx';
import { Question, OptionBank, sharedOptionsOf } from '../components/questions.jsx';
import { RichText } from '../components/rich-text.jsx';
import { useSubject } from '../subject.jsx';

// 不足一分钟就显示秒，免得刚交卷的报告写着"用时 0 分钟"
function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s < 60) return `${s} 秒`;
  return `${Math.round(s / 60)} 分钟`;
}

export default function ExamReport() {
  const { path } = useSubject();
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
      // 采分点式主观题（生化名词解释、问答……）一题一个结果，汇总着说
      const sub = r.subjective;
      if (sub?.graded) parts.push(`主观题批改了 ${sub.graded} 道，共得 ${sub.score} 分`);
      if (sub?.blank) parts.push(`${sub.blank} 道主观题没作答，记 0 分`);
      if (sub?.failed) parts.push(`${sub.failed} 道主观题批改失败，可稍后再点一次重试`);
      if (r.wrongItems?.done) parts.push(`${r.wrongItems.done} 道错题已生成解析`);
      if (r.wrongItems?.failed) parts.push(`${r.wrongItems.failed} 道错题解析失败`);
      const ok = r.essay?.status !== 'failed' && !sub?.failed && !r.wrongItems?.failed;
      setAiMsg({ kind: ok ? 'success' : 'error', text: parts.join('，') || '没有需要处理的内容' });
      setRep(await get(`/attempts/${attemptId}/report`));
    } catch (e) {
      setAiMsg({ kind: 'error', text: `AI 暂时不可用：${e.message}。客观题成绩不受影响。` });
    } finally { setAiBusy(false); }
  }

  if (error) return <Alert>{error}</Alert>;
  if (!rep) return <Loading label="正在生成报告" />;

  const { attempt, sectionScores, history, knowledgePoints, sections } = rep;
  // 满分按题现加（每道题在本卷的分值由模板给，记在 attempt_questions 上）。以前写死"作文 30 分"、
  // 按"待批改的部分"扣出客观题满分——生化一张卷 9 道主观题 50 分，两样都不对。
  const all = sections.flatMap((s) => s.questions);
  const sum = (qs) => Math.round(qs.reduce((n, q) => n + (Number(q.points) || 0), 0) * 100) / 100;
  const aiQs = all.filter((q) => q.needsAi);
  const pendingQs = aiQs.filter((q) => !q.aiJudged);
  const objectiveMax = sum(all.filter((q) => !q.needsAi));
  const paperMax = sum(all);
  const pendingPts = sum(pendingQs);
  // 只剩英语作文没批时照旧说"作文"，别的（生化名词解释、问答）说"主观题"
  const essayOnly = pendingQs.length > 0 && pendingQs.every((q) => q.questionType === 'essay');
  const pending = attempt.pendingAi > 0;
  const pct = objectiveMax ? Math.round((attempt.objectiveScore / objectiveMax) * 100) : 0;
  const weak = knowledgePoints.filter((k) => k.correct / k.total < 0.6);

  return (
    <>
      <PageHead
        title="成绩报告"
        desc={`${attempt.difficulty} · 用时 ${formatDuration(attempt.durationSeconds)}`}
        actions={<Link className="btn ghost sm" to={path('/history')}>历史记录</Link>}
      />

      {location.state?.auto ? (
        <div style={{ marginBottom: 12 }}><Alert kind="info">考试时间到，系统已自动交卷。</Alert></div>
      ) : null}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="spread">
          {pending || !aiQs.length ? (
            <div>
              <div className="small muted">{aiQs.length ? '客观题得分' : '得分'}</div>
              <div className="score-big">
                {attempt.objectiveScore}
                <span className="small muted" style={{ fontWeight: 400 }}> / {objectiveMax}</span>
              </div>
              <div className="tiny muted">正确率 {pct}%</div>
            </div>
          ) : (
            // 主观题都批完了：总分 = 各题得分之和（服务端批改完重算的 total_score）
            <div>
              <div className="small muted">总分</div>
              <div className="score-big" data-testid="total-score">
                {attempt.totalScore}
                <span className="small muted" style={{ fontWeight: 400 }}> / {paperMax}</span>
              </div>
              <div className="tiny muted">
                客观题 {attempt.objectiveScore} / {objectiveMax}（正确率 {pct}%）
                · 主观题 {Math.round((attempt.totalScore - attempt.objectiveScore) * 100) / 100} / {sum(aiQs)}
              </div>
            </div>
          )}
          {pending ? (
            <span className="badge gray" data-testid="pending-badge">
              {essayOnly ? `作文 ${pendingPts} 分待 AI 批改` : `主观题 ${pendingQs.length} 道（${pendingPts} 分）待 AI 批改`}
            </span>
          ) : null}
        </div>
        <div className="row" style={{ marginTop: 12 }}>
          <button className="btn sm" onClick={runAi} disabled={aiBusy}>
            {aiBusy ? 'AI 处理中…'
              : pending ? (essayOnly ? '批改作文并生成错题解析' : 'AI 批改主观题并生成错题解析')
                : '重新生成 AI 解析'}
          </button>
          <Link className="btn ghost sm" to={path('/wrongbook')}>错题本</Link>
          <Link className="btn ghost sm" to={path('/assessment')}>能力评估</Link>
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
                      <RichText text={s.passageText || s.writingPrompt} />
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
        <Link className="btn" to={path('/exam/new')}>再考一次</Link>
        <Link className="btn ghost" to={path('')}>回到首页</Link>
      </div>
    </>
  );
}
