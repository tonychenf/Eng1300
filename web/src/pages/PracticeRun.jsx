import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post } from '../api.js';
import { Alert, Loading } from '../components/ui.jsx';
import { Question, hasAnswer } from '../components/questions.jsx';
import { RichText } from '../components/rich-text.jsx';

const STAGE_HINT = {
  摸底: '每个考点先来一道，快速找出薄弱面',
  强化: '按掌握情况出题，答错的会更常出现',
  单考点专项: '这个考点下的题会一道道做完',
};

// 采分点答到几个、共几个（从逐点结果数，不从得分率反推：权重不同时两者对不上）
function pointsOf(fb) {
  return (fb.itemResults || []).flatMap((g) => g.items || []);
}
const pointsHit = (fb) => pointsOf(fb).filter((it) => it.hit === 1).length;
const pointsTotal = (fb) => pointsOf(fb).length;

export default function PracticeRun() {
  const { subjectCode, attemptId } = useParams();
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
  const [slow, setSlow] = useState(false);   // AI 批改超过 10 秒没回来

  const loadNext = useCallback(async () => {
    setBusy(true); setError(''); setFeedback(null); setAnswer(''); setOpenPassage(false);
    try {
      const r = await get(`/practice/${attemptId}/next`);
      if (r.done) { setDone(r); setCurrent(null); }
      else {
        setCurrent(r);
        // 带原文的选择题（段落填空、阅读）离开原文做不了：手机、平板上也默认展开（P1-X1）。
        // 写作提示这类短材料照旧收起
        setOpenPassage(Boolean(r.question?.passageText && r.question?.options?.length));
      }
    } catch (e) {
      if (e.code === 'already_submitted') {
        navigate(`/app/${subjectCode}/practice/${attemptId}/summary`, { replace: true });
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

  // retry：AI 没批出来时"再让 AI 批一次"——带同一份作答再交（服务端那条记录 is_correct 还空着，会放行）
  async function submit(retry = false) {
    if (!current) return;
    setBusy(true); setError(''); setSlow(false);
    const timer = current.question.needsAi ? setTimeout(() => setSlow(true), 10000) : null;
    try {
      const r = await post(`/practice/${attemptId}/answer`, {
        questionId: current.question.questionId,
        answer,
      });
      setFeedback(r);
      // 自己对照的题（AI 没批出来、或这门课没开练习批改）算已答，不进正确率的分母（同服务端 /practice/:id 的口径）
      setStats((s) => ({
        answered: (s?.answered || 0) + (retry ? 0 : 1),
        graded: (s?.graded || 0) + (r.isCorrect === null ? 0 : 1),
        correct: (s?.correct || 0) + (r.isCorrect === 1 ? 1 : 0),
      }));
    } catch (e) {
      setError(e.message);
    } finally {
      if (timer) clearTimeout(timer);
      setSlow(false);
      setBusy(false);
    }
  }

  async function end() {
    if (!confirm('结束本次练习？会生成一份掌握情况总结。')) return;
    setBusy(true);
    try {
      await post(`/practice/${attemptId}/end`);
    } catch { /* 已经结束过也没关系，照样去总结页 */ }
    navigate(`/app/${subjectCode}/practice/${attemptId}/summary`, { replace: true });
  }

  const answered = stats?.answered || 0;
  const graded = stats?.graded ?? answered;
  const accuracy = graded ? Math.round((stats.correct / graded) * 100) : 0;
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
            已答 {answered} 题{graded ? ` · 正确率 ${accuracy}%` : ''}
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
                  <RichText text={q.passageText || q.writingPrompt} />
                </div>
              </div>
            ) : null}

            <div>
              <div className="card">
                <div className="tiny muted" style={{ padding: '12px 16px 0' }}>{q.sectionType}</div>
                <Question
                  q={feedback ? {
                    ...q, userAnswer: answer, isCorrect: feedback.isCorrect,
                    correctAnswer: feedback.correctAnswer, explanation: null, score: 0,
                    // 逐空对错和每空的标准答案都在交答案的返回里。以前没并进来：多空题全答对了，
                    // 题卡上每个空照样标"错"、也不给标准答案
                    itemResults: feedback.itemResults,
                    // 候选池、无序并列的空按组给答案（"第 1、2 空可填：……"）
                    answerKey: feedback.answerKey,
                    scoreRate: feedback.scoreRate,
                    items: (q.items || []).map((it) => {
                      const src = feedback.items?.find((x) => x.ord === it.ord);
                      return { ...it, answer: src?.answer ?? null, altAnswers: src?.altAnswers || [] };
                    }),
                  } : q}
                  value={answer}
                  onChange={setAnswer}
                  review={Boolean(feedback)}
                  pendingLabel={feedback?.aiError ? '没批出来' : '练习不判分'}
                />
              </div>

              {feedback?.aiGraded ? (
                // 改进阶段 2（P1-G1）：按采分点判的题（翻译、名词解释、问答）当场 AI 批。
                // 逐点答到没有、为什么，在上面题卡的"逐点判定"里；这里给结论和参考答案
                <div className="card card-pad ai-graded" style={{ marginTop: 12 }}>
                  <div className="row" style={{ marginBottom: 8 }}>
                    {feedback.isCorrect === 1
                      ? <span className="badge ok">答对了</span>
                      : <span className="badge danger">答错了</span>}
                    <span className="badge info" data-testid="practice-ai-score">
                      采分点答到 {pointsHit(feedback)} 个，共 {pointsTotal(feedback)} 个
                    </span>
                    {feedback.knowledgePoints.map((k) => (
                      <span key={k} className="tag">{k}</span>
                    ))}
                  </div>
                  <p className="tiny muted" style={{ marginTop: 0 }}>
                    AI 按采分点批改，答到六成以上算对。练习的结果只用来安排你接下来练什么，不计入成绩。
                  </p>
                  {feedback.explanation ? (
                    <div className="passage" style={{ marginTop: 4 }}>{feedback.explanation}</div>
                  ) : null}
                </div>
              ) : feedback?.selfCheck ? (
                // AI 没批出来（超时、读不懂、今天次数用完），或这门课没开练习批改：判不出对错。
                // 不显示 0 分，把采分点摆出来让学员自己对照；没批出来的可以再试一次
                <div className="card card-pad self-check" style={{ marginTop: 12 }}>
                  <div className="row" style={{ marginBottom: 8 }}>
                    <span className="badge info">{feedback.aiError ? '这次没批出来' : '练习不判分'}</span>
                    {feedback.knowledgePoints.map((k) => (
                      <span key={k} className="tag">{k}</span>
                    ))}
                  </div>
                  <p className="small" style={{ marginTop: 0 }}>
                    {feedback.aiError
                      ? feedback.aiError.message
                      : '这类题按采分点给分，练习时不打分。对照下面的参考答案，看看自己答到了几点；模拟考试交卷后可以让 AI 逐点批改。'}
                  </p>
                  <div className="tiny muted" style={{ marginBottom: 4 }}>参考答案（采分点）</div>
                  <ol className="small score-points" style={{ marginTop: 0 }}>
                    {(feedback.items || []).filter((it) => it.kind === 'SCORE_POINT' || it.kind === 'STEP')
                      .map((it) => <li key={it.ord}>{it.answer}</li>)}
                  </ol>
                  {feedback.explanation ? (
                    <div className="passage" style={{ marginTop: 4 }}>{feedback.explanation}</div>
                  ) : null}
                  {feedback.aiError && feedback.aiError.code !== 'daily_limit' ? (
                    <button className="btn ghost" style={{ marginTop: 8 }} onClick={() => submit(true)} disabled={busy}>
                      {busy ? 'AI 正在批改…' : '再让 AI 批一次'}
                    </button>
                  ) : null}
                </div>
              ) : feedback ? (
                <div className="card card-pad" style={{ marginTop: 12 }}>
                  <div className="row" style={{ marginBottom: 8 }}>
                    {feedback.isCorrect === 1
                      ? <span className="badge ok">答对了</span>
                      : <span className="badge danger">答错了</span>}
                    {feedback.knowledgePoints.map((k) => (
                      <span key={k} className="tag">{k}</span>
                    ))}
                  </div>
                  {/* 正确答案题卡上已经标了（选择题标绿、一空一框的每空下面写着），这里不再写一遍（P1-X3） */}
                  {feedback.explanation ? (
                    <div className="passage" style={{ marginTop: 4 }}>{feedback.explanation}</div>
                  ) : (
                    <p className="small muted" style={{ marginBottom: 0 }}>这道题还没有解析。</p>
                  )}
                </div>
              ) : null}

              <div className="sticky-actions">
                {feedback ? (
                  <button className="btn" onClick={loadNext} disabled={busy}>
                    {busy ? '出题中…' : '下一题'}
                  </button>
                ) : (
                  <button className="btn" onClick={() => submit(false)}
                    disabled={busy || !hasAnswer(q, answer)}>
                    {busy ? (q.needsAi ? (slow ? 'AI 有点慢，再等等…' : 'AI 正在批改…') : '提交中…') : '提交答案'}
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
