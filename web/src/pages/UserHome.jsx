import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get } from '../api.js';
import { useAuth } from '../auth.jsx';
import { Icon } from '../components/icons.jsx';
import { useSubject } from '../subject.jsx';
import { formatBeijing } from '../lib/time.js';
import { greeting, lastSevenDays, streakDays } from '../lib/activity.js';

// 学科首页（2026-11-16 改版，用户：「首页做的酷炫一点」）：
//   动态问候卡片（流动渐变 + 漂浮光斑 + 点阵纹理，右侧是最近模考的得分环）、连续学习天数、四个滚动计数的数字、
//   本周学习柱状图、考点掌握环形图、常用功能、最近记录、课程信息。整页依次淡入；系统设了「减少动态效果」的一律不动。
// 数据都来自现成接口：/history（跨学科，按本学科课程过滤）、/practice/active、/assessment。取不到就不显示那一块，不挡主功能。
const TILES = [
  { key: 'practice', icon: 'target', title: '专项练习', desc: '先摸底，再按薄弱考点反复练', to: '/practice/new', tone: 'indigo' },
  { key: 'exam', icon: 'exam', title: '模拟考试', desc: '按考纲组卷，限时作答', to: '/exam/new', tone: 'violet' },
  { key: 'wrong', icon: 'book', title: '错题本', desc: '做错的题集中订正、看错因', to: '/wrongbook', tone: 'rose' },
  { key: 'assess', icon: 'chart', title: '能力评估', desc: '各考点掌握情况与分数预测', to: '/assessment', tone: 'emerald' },
];
const TIERS = [
  { key: '已掌握', color: '#10b981' },
  { key: '待巩固', color: '#f59e0b' },
  { key: '薄弱', color: '#f43f5e' },
];

const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** 数字从 0 滚到目标值（约 0.9 秒，先快后慢） */
function useCountUp(target, ms = 900) {
  const [v, setV] = useState(0);
  useEffect(() => {
    if (target == null || Number.isNaN(target)) return undefined;
    if (reduceMotion()) { setV(target); return undefined; }
    let raf; const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      setV(target * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
}

function CountUp({ value, decimals = 0 }) {
  const v = useCountUp(value);
  return <>{value == null ? '—' : v.toFixed(decimals)}</>;
}

/** 进度环：挂上之后再把弧长从 0 过渡到目标，看起来是"画"出来的 */
function Ring({ pct, size = 132, stroke = 12, children }) {
  const [shown, setShown] = useState(0);
  useEffect(() => { const id = requestAnimationFrame(() => setShown(pct)); return () => cancelAnimationFrame(id); }, [pct]);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <defs>
          <linearGradient id="ring-grad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#a5f3fc" /><stop offset="100%" stopColor="#ffffff" />
          </linearGradient>
        </defs>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,.18)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#ring-grad)" strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, shown)))}
          transform={`rotate(-90 ${size / 2} ${size / 2})`} className="ring-arc" />
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

/** 环形图：各段按比例接成一圈 */
function Donut({ segments, size = 128, stroke = 16, children }) {
  const total = segments.reduce((s, x) => s + x.value, 0) || 1;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#eef2f7" strokeWidth={stroke} />
        {segments.filter((s) => s.value > 0).map((s) => {
          const len = (s.value / total) * c;
          const el = (
            <circle key={s.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={s.color} strokeWidth={stroke}
              strokeDasharray={`${Math.max(0, len - 2)} ${c}`} strokeDashoffset={-acc}
              transform={`rotate(-90 ${size / 2} ${size / 2})`} className="donut-seg" />
          );
          acc += len;
          return el;
        })}
      </svg>
      <div className="ring-center">{children}</div>
    </div>
  );
}

function scoreOf(a) {
  if (a.status === '进行中' || a.objective_score === null) return null;
  if (a.pending_ai > 0) return { value: Number(a.objective_score), text: `${a.objective_score}+`, max: Number(a.max_score), note: '主观题待批改' };
  const v = Number(a.total_score ?? a.objective_score);
  return { value: v, text: `${v}`, max: Number(a.max_score), note: `满分 ${a.max_score}` };
}

export default function UserHome() {
  const { subject, path, courses: subjectCourses } = useSubject();
  const { user } = useAuth();
  const [history, setHistory] = useState(null);
  const [active, setActive] = useState(null);
  const [assess, setAssess] = useState(null);
  const now = useRef(Date.now()).current;
  const courses = subjectCourses || [];
  const mainCourse = courses[0];
  const practiceFirst = subject?.contentGroupKind === 'TEXTBOOK_CHAPTER';

  useEffect(() => {
    let off = false;
    get('/history').then((r) => { if (!off) setHistory(r.attempts || []); }).catch(() => { if (!off) setHistory([]); });
    if (mainCourse) {
      const cc = encodeURIComponent(mainCourse.course_code);
      get(`/practice/active?courseCode=${cc}`).then((r) => { if (!off) setActive(r.active); }).catch(() => {});
      get(`/assessment?courseCode=${cc}`).then((r) => { if (!off) setAssess(r); }).catch(() => {});
    }
    return () => { off = true; };
  }, [mainCourse?.course_code]);

  const mine = new Set(courses.map((c) => c.course_code));
  const rows = (history || []).filter((a) => mine.has(a.course_code));
  const exams = rows.filter((a) => a.mode === 'EXAM');
  const doneExams = exams.filter((a) => a.status !== '进行中');
  const practices = rows.filter((a) => a.mode === 'PRACTICE');
  const last = doneExams.length ? scoreOf(doneExams[0]) : null;
  const lastPct = last && last.max > 0 ? last.value / last.max : 0;
  const times = rows.map((a) => a.started_at);
  const streak = history ? streakDays(times, now) : 0;
  const week = lastSevenDays(times, now);
  const weekTotal = week.reduce((s, d) => s + d.count, 0);
  const weekMax = Math.max(1, ...week.map((d) => d.count));
  const tierCount = assess?.tierCount || {};
  const touched = TIERS.reduce((s, t) => s + (tierCount[t.key] || 0), 0);
  const mastered = tierCount['已掌握'] || 0;
  const tiles = practiceFirst ? TILES : [TILES[1], TILES[0], TILES[2], TILES[3]];

  const linkOf = (a) => {
    if (a.mode === 'EXAM') return a.status === '进行中' ? path(`/exam/${a.attempt_id}/take`) : path(`/exam/${a.attempt_id}/report`);
    return a.status === '进行中' ? path(`/practice/${a.attempt_id}/run`) : path(`/practice/${a.attempt_id}/summary`);
  };
  const message = active
    ? `有一次练习还没做完（已做 ${active.asked} 题），接着来吧`
    : streak > 1 ? `已经连续学习 ${streak} 天，今天也别断` : doneExams.length ? `已完成 ${doneExams.length} 次模考，保持节奏` : '从一次专项练习开始，先摸清自己的薄弱点';

  return (
    <div className="home">
      <section className="hero2 reveal" data-testid="home-hero">
        <span className="hero-orb o1" aria-hidden="true" />
        <span className="hero-orb o2" aria-hidden="true" />
        <span className="hero-orb o3" aria-hidden="true" />
        <span className="hero-dots" aria-hidden="true" />
        <div className="hero2-body">
          <div className="hero2-main">
            <div className="hero-chips">
              <span className="glass-chip">{subject?.name}</span>
              {streak > 0 ? (
                <span className="glass-chip flame" data-testid="home-streak"><Icon name="flame" size={14} /> 连续学习 {streak} 天</span>
              ) : null}
            </div>
            <h1>{greeting(now)}，<span className="hero-name">{user?.username}</span></h1>
            <p>{message}</p>
            <div className="row hero-actions">
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
          </div>
          <div className="hero2-ring">
            {last ? (
              <Ring pct={lastPct}>
                <span className="ring-num"><CountUp value={last.value} decimals={Number.isInteger(last.value) ? 0 : 1} /></span>
                <span className="ring-sub">最近模考 / {last.max}</span>
              </Ring>
            ) : (
              <div className="ring-empty"><Icon name="trophy" size={28} /><span>考完一次模考<br />这里显示成绩环</span></div>
            )}
          </div>
        </div>
      </section>

      <div className="kpi-row">
        {[
          { key: 'streak', icon: 'flame', tone: 'amber', label: '连续学习', value: history ? streak : null, unit: '天' },
          { key: 'exam', icon: 'exam', tone: 'violet', label: '模考', value: history ? doneExams.length : null, unit: '次' },
          { key: 'practice', icon: 'target', tone: 'indigo', label: '练习', value: history ? practices.length : null, unit: '次' },
          { key: 'mastered', icon: 'trophy', tone: 'emerald', label: '已掌握考点', value: assess ? mastered : null, unit: '个' },
        ].map((k, i) => (
          <div className="kpi reveal" style={{ '--d': `${80 + i * 60}ms` }} key={k.key}>
            <span className={`kpi-icon g-${k.tone}`}><Icon name={k.icon} size={18} /></span>
            <span className="kpi-label">{k.label}</span>
            <span className="kpi-value"><CountUp value={k.value} /><small>{k.unit}</small></span>
          </div>
        ))}
      </div>

      <div className="home-pair">
        <div className="card card-pad reveal" style={{ '--d': '320ms' }}>
          <div className="spread" style={{ marginBottom: 14 }}>
            <h2 className="card-title"><Icon name="calendar" size={18} /> 本周学习</h2>
            <span className="tiny muted">共 {weekTotal} 次</span>
          </div>
          <div className="week-bars" data-testid="home-week">
            {week.map((d) => (
              <div className={`week-col${d.today ? ' today' : ''}`} key={d.label}>
                <span className="week-count">{d.count || ''}</span>
                <span className="week-bar"><span style={{ height: `${d.count ? Math.max(10, (d.count / weekMax) * 100) : 4}%` }} /></span>
                <span className="week-label">{d.label}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="card card-pad reveal" style={{ '--d': '380ms' }}>
          <div className="spread" style={{ marginBottom: 14 }}>
            <h2 className="card-title"><Icon name="chart" size={18} /> 考点掌握</h2>
            <Link className="tiny" to={path('/assessment')}>详细评估</Link>
          </div>
          {touched ? (
            <div className="donut-wrap">
              <Donut segments={TIERS.map((t) => ({ key: t.key, color: t.color, value: tierCount[t.key] || 0 }))}>
                <span className="ring-num dark"><CountUp value={mastered} /></span>
                <span className="ring-sub dark">已掌握 / {touched}</span>
              </Donut>
              <ul className="legend">
                {TIERS.map((t) => (
                  <li key={t.key}><span className="dot" style={{ background: t.color }} />{t.key}<strong>{tierCount[t.key] || 0}</strong></li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="small muted" style={{ margin: 0 }}>做几道题之后，这里会按考点显示掌握、待巩固和薄弱。</p>
          )}
        </div>
      </div>

      <h2 className="section-title">常用功能</h2>
      <div className="tile-grid">
        {tiles.map((t, i) => (
          <Link key={t.key} className="action-tile reveal" style={{ '--d': `${420 + i * 50}ms` }} to={path(t.to)} data-testid={`home-tile-${t.key}`}>
            <span className={`tile-icon g-${t.tone}`}><Icon name={t.icon} size={22} /></span>
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
          <div className="card card-pad course-card" key={c.course_code}>
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
    </div>
  );
}
