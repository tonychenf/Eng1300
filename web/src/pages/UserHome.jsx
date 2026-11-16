import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Icon } from '../components/icons.jsx';
import { useSubject } from '../subject.jsx';
import { formatBeijing } from '../lib/time.js';

// 学科首页（2026-11-16 改版）：问候卡片 + 一个主按钮（有没做完的练习就是「继续」）、三个数字、四个常用功能、最近记录、课程信息。
// 数据都来自现成的接口：/history（跨学科，这里按本学科的课程过滤）、/practice/active。取不到就不显示那一块，不挡住主功能。
const TILES = [
  { key: 'practice', icon: 'target', title: '专项练习', desc: '先摸底，再按薄弱考点反复练', to: '/practice/new', tone: 'indigo' },
  { key: 'exam', icon: 'exam', title: '模拟考试', desc: '按考纲组卷，限时作答', to: '/exam/new', tone: 'violet' },
  { key: 'wrong', icon: 'book', title: '错题本', desc: '做错的题集中订正、看错因', to: '/wrongbook', tone: 'rose' },
  { key: 'assess', icon: 'chart', title: '能力评估', desc: '各考点掌握情况与分数预测', to: '/assessment', tone: 'emerald' },
];

function scoreOf(a) {
  if (a.status === '进行中' || a.objective_score === null) return null;
  if (a.pending_ai > 0) return { text: `${a.objective_score}+`, note: '主观题待批改' };
  return { text: `${a.total_score ?? a.objective_score}`, note: `满分 ${a.max_score}` };
}

export default function UserHome() {
  const { subject, path, courses: subjectCourses } = useSubject();
  const { user } = useAuth();
  const [history, setHistory] = useState(null);
  const [active, setActive] = useState(null);
  const courses = subjectCourses || [];
  const mainCourse = courses[0];
  const practiceFirst = subject?.contentGroupKind === 'TEXTBOOK_CHAPTER';

  useEffect(() => {
    let off = false;
    get('/history').then((r) => { if (!off) setHistory(r.attempts || []); }).catch(() => { if (!off) setHistory([]); });
    if (mainCourse) {
      get(`/practice/active?courseCode=${mainCourse.course_code}`)
        .then((r) => { if (!off) setActive(r.active); }).catch(() => {});
    }
    return () => { off = true; };
  }, [mainCourse?.course_code]);

  const mine = new Set(courses.map((c) => c.course_code));
  const rows = (history || []).filter((a) => mine.has(a.course_code));
  const exams = rows.filter((a) => a.mode === 'EXAM');
  const doneExams = exams.filter((a) => a.status !== '进行中');
  const practices = rows.filter((a) => a.mode === 'PRACTICE');
  const lastScore = doneExams.length ? scoreOf(doneExams[0]) : null;
  const tiles = practiceFirst ? TILES : [TILES[1], TILES[0], TILES[2], TILES[3]];

  const linkOf = (a) => {
    if (a.mode === 'EXAM') return a.status === '进行中' ? path(`/exam/${a.attempt_id}/take`) : path(`/exam/${a.attempt_id}/report`);
    return a.status === '进行中' ? path(`/practice/${a.attempt_id}/run`) : path(`/practice/${a.attempt_id}/summary`);
  };

  return (
    <>
      <section className="home-hero" data-testid="home-hero">
        <div className="home-hero-sub">{subject?.name}</div>
        <h1>你好，{user?.username}</h1>
        <p>{active
          ? `有一次练习还没做完（已做 ${active.asked} 题），接着来吧`
          : doneExams.length ? `已完成 ${doneExams.length} 次模考，保持节奏` : '从一次专项练习开始，先摸清自己的薄弱点'}</p>
        <div className="row" style={{ marginTop: 16 }}>
          {active ? (
            <Link className="btn hero-btn" to={path(`/practice/${active.attempt_id}/run`)}><Icon name="play" size={16} /> 继续练习</Link>
          ) : (
            <Link className="btn hero-btn" to={path(practiceFirst ? '/practice/new' : '/exam/new')}>
              <Icon name="play" size={16} /> {practiceFirst ? '开始练习' : '开始模考'}
            </Link>
          )}
          <Link className="btn hero-ghost" to={path(practiceFirst ? '/exam/new' : '/practice/new')}>
            {practiceFirst ? '模拟考试' : '专项练习'}
          </Link>
        </div>
      </section>

      <div className="stat-row">
        <div className="stat-tile">
          <span className="stat-label">最近模考</span>
          <span className="stat-value">{lastScore ? lastScore.text : '—'}</span>
          <span className="stat-note">{lastScore ? lastScore.note : '还没考过'}</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">模考次数</span>
          <span className="stat-value">{history ? doneExams.length : '…'}</span>
          <span className="stat-note">已交卷</span>
        </div>
        <div className="stat-tile">
          <span className="stat-label">练习次数</span>
          <span className="stat-value">{history ? practices.length : '…'}</span>
          <span className="stat-note">专项练习</span>
        </div>
      </div>

      <h2 className="section-title">常用功能</h2>
      <div className="tile-grid">
        {tiles.map((t) => (
          <Link key={t.key} className="action-tile" to={path(t.to)} data-testid={`home-tile-${t.key}`}>
            <span className={`tile-icon tone-${t.tone}`}><Icon name={t.icon} size={22} /></span>
            <span className="tile-text">
              <strong>{t.title}</strong>
              <span>{t.desc}</span>
            </span>
            <Icon name="arrow" size={18} className="tile-arrow" />
          </Link>
        ))}
      </div>

      {rows.length ? (
        <>
          <div className="spread" style={{ marginTop: 28, marginBottom: 10 }}>
            <h2 className="section-title" style={{ margin: 0 }}>最近记录</h2>
            <Link className="small" to={path('/history')}>全部模考记录</Link>
          </div>
          <div className="card list-card">
            {rows.slice(0, 4).map((a) => {
              const sc = scoreOf(a);
              return (
                <Link key={a.attempt_id} className="list-row" to={linkOf(a)}>
                  <span className={`tile-icon sm tone-${a.mode === 'EXAM' ? 'violet' : 'indigo'}`}>
                    <Icon name={a.mode === 'EXAM' ? 'exam' : 'target'} size={18} />
                  </span>
                  <span className="list-main">
                    <strong>{a.mode === 'EXAM' ? '模拟考试' : '专项练习'}</strong>
                    <span className="tiny muted">{formatBeijing(a.started_at)}</span>
                  </span>
                  {a.status === '进行中'
                    ? <span className="badge warn">进行中</span>
                    : sc ? <span className="list-score">{sc.text}</span> : <span className="badge ok">已完成</span>}
                </Link>
              );
            })}
          </div>
        </>
      ) : null}

      <h2 className="section-title" style={{ marginTop: 28 }}>课程</h2>
      <div className="grid-cards">
        {courses.map((c) => (
          <div className="card card-pad" key={c.course_code}>
            <h3 style={{ fontSize: 16 }}>{c.course_name}</h3>
            <p className="small muted" style={{ margin: '6px 0 0' }}>
              考试时长 {c.time_limit_minutes} 分钟 · 满分 {c.total_score} 分
            </p>
            <p className="small" style={{ margin: '4px 0 0' }}>
              可用真题 <strong>{c.published_exams}</strong> 套 · 题目 <strong>{c.published_questions}</strong> 道
            </p>
          </div>
        ))}
      </div>
    </>
  );
}
