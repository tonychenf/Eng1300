import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../api.js';
import { Alert, Loading } from '../components/ui.jsx';
import { Question } from '../components/questions.jsx';

const STAGE_HINT = {
  摸底: '每个考点先来一道，快速找出薄弱面',
  强化: '按掌握情况出题，答错的会更常出现',
  单考点专项: '这个考点下的题会一道道做完',
};

export default function PracticeRun() {
  const { attemptId } = useParams();
  const navigate = useNavigate();

  const [current, setCurrent] = useState(null);   // { stage, question }
  const [answer, setAnswer] = useState('');
  const [feedback, setFeedback] = useState(null); // 提交后才有
  const [stats, setStats] = useState(null);   // 从服务端取，中断恢复后计数才接得上
  const [sessionStage, setSessionStage] = useState(null);
  const [done, setDone] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openPassage, setOpenPassage] = useState(false);

  const loadNext = useCallback(async () => {
    setBusy(true); setError(''); setFeedback(null); setAnswer(''); setOpenPassage(false);
    try {
      const r = await get(`/practice/${attemptId}/next`);
      if (r.done) { setDone(r); setCurrent(null); }
      else setCurrent(r);
    } catch (e) {
      if (e.code === 'already_submitted') {
        navigate(`/app/practice/${attemptId}/summary`, { replace: true });
        return;
      }
      setError(e.message);
    } finally { setBusy(false); }
  }, [attemptId, navigate]);

  // 先把会话概况取回来：阶段和已答计数都在服务端，
  // 刷新或换设备后本地状态是空的，不取就会显示成"已答 0 题"。
  useEffect(() => {
    let cancelled = false;
    get(`/practice/${attemptId}`)
      .then((r) => {
        if (cancelled) return;
        setStats(r.stats);
        setSessionStage(r.attempt.stage);
      })
      .catch((e) => { if (!cancelled) setError(e.message); });
    return () => { cancelled = true; };
  }, [attemptId]);

  useEffect(() => { loadNext(); }, [loadNext]);

  async function submit() {
    if (!current) return;
    setBusy(true); setError('');
    try {
      const r = await post(`/practice/${attemptId}/answer`, {
        questionId: current.question.questionId,
        answer,
      });
      setFeedback(r);
      setStats((s) => ({
        answered: (s?.answered || 0) + 1,
        correct: (s?.correct || 0) + (r.isCorrect === 1 ? 1 : 0),
      }));
    } catch (e) {
      setError(e.message);
    } finally { setBusy(false); }
  }

  async function end() {
    if (!confirm('结束本次练习？会生成一份掌握情况总结。')) return;
    setBusy(true);
    try {
      await post(`/practice/${attemptId}/end`);
    } catch { /* 已经结束过也没关系，照样去总结页 */ }
    navigate(`/app/practice/${attemptId}/summary`, { replace: true });
  }

  const answered = stats?.answered || 0;
  const accuracy = answered ? Math.round((stats.correct / answered) * 100) : 0;
  // 阶段以最新一次出题为准；还没出题时用会话概况里的，避免先闪一个占位文案
  const stage = current?.stage || sessionStage;
  const q = current?.question;
  const hasPassage = Boolean(q?.passageText || q?.writingPrompt);

  return (
    <div className="exam-shell">
      <header className="exam-bar">
        <div className="grow">
          <div className="exam-title">
            {stage ? (
              <>
                <span className="badge info" style={{ marginRight: 8 }}>{stage}</span>
                {STAGE_HINT[stage] || ''}
              </>
            ) : <span className="muted">载入中…</span>}
          </div>
          <div className="exam-sub">
            已答 {answered} 题{answered ? ` · 正确率 ${accuracy}%` : ''}
          </div>
        </div>
        <button className="btn ghost sm" onClick={end} disabled={busy}>结束练习</button>
      </header>

      <div className="exam-body">
        {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}

        {done ? (
          <div className="card card-pad">
            <h2 style={{ fontSize: 16, marginBottom: 8 }}>这个范围练完了</h2>
            <p className="small muted">{done.message}</p>
            <button className="btn" onClick={end}>看总结</button>
          </div>
        ) : !q ? (
          <Loading label="出题中" />
        ) : (
          <div className="exam-split">
            {hasPassage ? (
              <div className="card card-pad exam-passage">
                <button className="passage-toggle" onClick={() => setOpenPassage((v) => !v)}>
                  <span>{q.passageTitle || '原文'}</span>
                  <span className="tiny muted">{openPassage ? '收起' : '展开'}</span>
                </button>
                <div className={`passage passage-body${openPassage ? '' : ' collapsed'}`}
                  style={{ marginTop: 8 }}>
                  {q.passageText || q.writingPrompt}
                </div>
              </div>
            ) : null}

            <div>
              <div className="card">
                <div className="tiny muted" style={{ padding: '12px 16px 0' }}>{q.sectionType}</div>
                <Question
                  q={feedback ? { ...q, userAnswer: answer, isCorrect: feedback.isCorrect,
                                  correctAnswer: feedback.correctAnswer, explanation: null, score: 0 } : q}
                  value={answer}
                  onChange={setAnswer}
                  review={Boolean(feedback)}
                />
              </div>

              {feedback ? (
                <div className="card card-pad" style={{ marginTop: 12 }}>
                  <div className="row" style={{ marginBottom: 8 }}>
                    {feedback.isCorrect === 1
                      ? <span className="badge ok">答对了</span>
                      : <span className="badge danger">答错了</span>}
                    {feedback.knowledgePoints.map((k) => (
                      <span key={k} className="tag">{k}</span>
                    ))}
                  </div>
                  {feedback.isCorrect !== 1 ? (
                    <p className="small" style={{ marginTop: 0 }}>
                      正确答案：<strong>{feedback.correctAnswer}</strong>
                    </p>
                  ) : null}
                  {feedback.explanation ? (
                    <div className="passage" style={{ marginTop: 4 }}>{feedback.explanation}</div>
                  ) : (
                    <p className="small muted" style={{ marginBottom: 0 }}>
                      这道题题库里没有官方解析。AI 讲解会在下一阶段接入。
                    </p>
                  )}
                </div>
              ) : null}

              <div className="sticky-actions">
                {feedback ? (
                  <button className="btn" onClick={loadNext} disabled={busy}>
                    {busy ? '出题中…' : '下一题'}
                  </button>
                ) : (
                  <button className="btn" onClick={submit}
                    disabled={busy || !String(answer).trim()}>
                    {busy ? '提交中…' : '提交答案'}
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
