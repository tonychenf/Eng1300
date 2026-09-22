import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { get, post, put } from '../api.js';
import { Alert, Loading } from '../components/ui.jsx';
import { Question, OptionBank, sharedOptionsOf } from '../components/questions.jsx';

const WARN_AT = 5 * 60; // 剩 5 分钟提醒一次

function mmss(total) {
  const s = Math.max(0, total);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}

export default function ExamTake() {
  const { attemptId } = useParams();
  const navigate = useNavigate();

  const [data, setData] = useState(null);
  const [answers, setAnswers] = useState({});
  const [remaining, setRemaining] = useState(null);
  const [secIndex, setSecIndex] = useState(0);
  const [openPassage, setOpenPassage] = useState(false);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [warned, setWarned] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const timers = useRef({});
  const submittedRef = useRef(false);

  const load = useCallback(async () => {
    const r = await get(`/attempts/${attemptId}`);
    setData(r);
    setRemaining(r.attempt.remainingSeconds);
    const init = {};
    for (const s of r.sections) for (const q of s.questions) init[q.questionId] = q.userAnswer ?? '';
    setAnswers(init);
    return r;
  }, [attemptId]);

  useEffect(() => {
    load().catch((e) => setError(e.message));
  }, [load]);

  // 交卷后直接去报告页
  useEffect(() => {
    if (data && data.attempt.status !== '进行中') {
      navigate(`/app/exam/${attemptId}/report`, { replace: true });
    }
  }, [data, attemptId, navigate]);

  const doSubmit = useCallback(async (auto) => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setSubmitting(true);
    try {
      await post(`/attempts/${attemptId}/submit`);
    } catch (e) {
      // 服务端可能已经因为超时自动交过卷了，那也算成功
      if (e.code !== 'already_submitted') {
        submittedRef.current = false;
        setSubmitting(false);
        setError(e.message);
        return;
      }
    }
    navigate(`/app/exam/${attemptId}/report`, { replace: true, state: { auto } });
  }, [attemptId, navigate]);

  // 本地每秒走一格；真正的时间以服务端为准，回到页面时重新对时
  useEffect(() => {
    if (remaining === null) return;
    if (remaining <= 0) { doSubmit(true); return; }
    const id = setInterval(() => setRemaining((r) => (r === null ? r : r - 1)), 1000);
    return () => clearInterval(id);
  }, [remaining === null, remaining <= 0, doSubmit]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    function resync() {
      if (document.visibilityState !== 'visible' || submittedRef.current) return;
      get(`/attempts/${attemptId}`)
        .then((r) => {
          setRemaining(r.attempt.remainingSeconds);
          if (r.attempt.status !== '进行中') {
            submittedRef.current = true;
            navigate(`/app/exam/${attemptId}/report`, { replace: true, state: { auto: true } });
          }
        })
        .catch(() => {});
    }
    document.addEventListener('visibilitychange', resync);
    return () => document.removeEventListener('visibilitychange', resync);
  }, [attemptId, navigate]);

  useEffect(() => {
    if (remaining !== null && remaining <= WARN_AT && remaining > 0 && !warned) setWarned(true);
  }, [remaining, warned]);

  // 选项立即存，输入框停 600ms 再存，避免每敲一个字母发一次请求
  function save(questionId, answer, immediate) {
    setAnswers((a) => ({ ...a, [questionId]: answer }));
    clearTimeout(timers.current[questionId]);
    const send = async () => {
      setSaving(true);
      try {
        await put(`/attempts/${attemptId}/answers`, { questionId, answer });
        setError('');
      } catch (e) {
        if (e.code === 'already_submitted') {
          submittedRef.current = true;
          navigate(`/app/exam/${attemptId}/report`, { replace: true, state: { auto: true } });
          return;
        }
        setError('答案没能保存，请检查网络：' + e.message);
      } finally { setSaving(false); }
    };
    if (immediate) send();
    else timers.current[questionId] = setTimeout(send, 600);
  }

  // 离开页面前把还在等待的输入立刻写出去
  useEffect(() => () => {
    for (const id of Object.values(timers.current)) clearTimeout(id);
  }, []);

  if (error && !data) return <div className="content"><Alert>{error}</Alert></div>;
  if (!data) return <Loading />;
  if (data.attempt.status !== '进行中') return <Loading label="正在打开成绩报告" />;

  const sections = data.sections;
  const section = sections[secIndex];
  const shared = sharedOptionsOf(section);
  const all = sections.flatMap((s) => s.questions);
  const answeredCount = all.filter((q) => String(answers[q.questionId] ?? '').trim()).length;
  const unanswered = all.length - answeredCount;

  function confirmSubmit() {
    const msg = unanswered > 0
      ? `还有 ${unanswered} 题没作答，确认交卷？交卷后不能再修改。`
      : '确认交卷？交卷后不能再修改。';
    if (confirm(msg)) doSubmit(false);
  }

  const hasPassage = Boolean(section.passageText || section.writingPrompt);

  return (
    <div className="exam-shell">
      <header className="exam-bar">
        <div className="grow">
          <div className="exam-title">第 {section.sectionOrd} 部分 · {section.sectionType}</div>
          <div className="exam-sub">
            已答 {answeredCount}/{all.length}
            {saving ? ' · 保存中…' : ''}
          </div>
        </div>
        <div className={`timer${remaining !== null && remaining <= WARN_AT ? ' warn' : ''}`}>
          {remaining === null ? '--:--' : mmss(remaining)}
        </div>
        <button className="btn sm" onClick={confirmSubmit} disabled={submitting}>
          {submitting ? '交卷中…' : '交卷'}
        </button>
      </header>

      <div className="exam-body">
        {warned && remaining > 0 ? (
          <div style={{ marginBottom: 12 }}>
            <Alert>剩余时间不足 5 分钟，时间到会自动交卷。</Alert>
          </div>
        ) : null}
        {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}

        <nav className="sec-nav">
          {sections.map((s, i) => {
            const done = s.questions.filter((q) => String(answers[q.questionId] ?? '').trim()).length;
            return (
              <button key={s.sectionOrd} className={i === secIndex ? 'active' : undefined}
                onClick={() => { setSecIndex(i); setOpenPassage(false); window.scrollTo(0, 0); }}>
                {s.sectionOrd}
                {done === s.questions.length ? <span className="done">✓</span> : null}
              </button>
            );
          })}
        </nav>

        <div className="exam-split">
          {hasPassage ? (
            <div className="card card-pad exam-passage">
              <button className="passage-toggle" onClick={() => setOpenPassage((v) => !v)}>
                <span>{section.passageTitle || (section.writingPrompt ? '写作要求' : '原文')}</span>
                <span className="tiny muted" aria-hidden="true">{openPassage ? '收起' : '展开'}</span>
              </button>
              <div className={`passage passage-body${openPassage ? '' : ' collapsed'}`}
                style={{ marginTop: 8 }}>
                {section.passageText || section.writingPrompt}
              </div>
            </div>
          ) : null}

          <div className="card">
            {shared ? <div style={{ padding: 16, paddingBottom: 0 }}><OptionBank options={shared} /></div> : null}
            {section.questions.map((q) => (
              <Question
                key={q.questionId}
                q={q}
                compact={Boolean(shared)}
                value={answers[q.questionId] ?? ''}
                onChange={(v) => save(q.questionId, v, q.questionType === 'single_choice')}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
