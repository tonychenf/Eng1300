import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Alert } from '../components/ui.jsx';
import { Icon } from '../components/icons.jsx';

// admin=true 时为后台入口，只放行超级管理员
export default function Login({ admin = false }) {
  const { user, login, logout } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (user) {
    const home = user.role === 'SUPER_ADMIN' ? '/admin' : '/app';
    return <Navigate to={admin && user.role !== 'SUPER_ADMIN' ? '/app' : home} replace />;
  }

  async function onSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const me = await login(username.trim(), password);
      if (admin && me.role !== 'SUPER_ADMIN') {
        // 同一个事件里 login/logout 会被批处理，不会闪一下后台页面
        logout();
        setError('该账号没有后台权限，请从学员入口登录');
        return;
      }
      navigate(me.role === 'SUPER_ADMIN' && admin ? '/admin' : '/app', { replace: true });
    } catch (err) {
      setError(err.message || '登录失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`auth-wrap${admin ? ' admin' : ''}`}>
      {/* 背景（2026-11-16 改版）：流动的极光渐变、漂浮光斑、缓缓上浮的学习符号。纯装饰，读屏跳过；
          系统设了「减少动态效果」的全部静止（styles.css 的 prefers-reduced-motion 一节） */}
      <div className="aurora" aria-hidden="true">
        <span className="aurora-blob b1" /><span className="aurora-blob b2" /><span className="aurora-blob b3" />
        <span className="aurora-grid" />
        {GLYPHS.map((g, i) => (
          <span key={i} className="glyph" style={{ left: g.x, animationDuration: g.dur, animationDelay: g.delay, fontSize: g.size }}>{g.t}</span>
        ))}
      </div>

      <div className="auth-brand">
        <div>
          <div className="row" style={{ gap: 12 }}>
            <span className="brand-mark lg" aria-hidden="true">X</span>
            <h1 style={{ fontSize: 30 }}>XLearn</h1>
          </div>
          <h2 className="auth-tagline">把每一分<br /><span>都拿稳</span></h2>
          <p style={{ opacity: .8, maxWidth: 420, marginTop: 14 }}>
            跨学科自适应学习平台。按考纲结构组卷、限时作答、错题解析与能力评估。
          </p>
        </div>
        {/* 产品预览：几张轻轻浮动的小卡片（纯装饰，数字是示意） */}
        <div className="preview-stack" aria-hidden="true">
          <div className="pv-card pv-score">
            <svg width="64" height="64" viewBox="0 0 64 64">
              <circle cx="32" cy="32" r="26" fill="none" stroke="rgba(255,255,255,.18)" strokeWidth="7" />
              <circle cx="32" cy="32" r="26" fill="none" stroke="#a5f3fc" strokeWidth="7" strokeLinecap="round"
                strokeDasharray="163.4" strokeDashoffset="26" transform="rotate(-90 32 32)" className="pv-arc" />
            </svg>
            <div><div className="pv-big">86</div><div className="pv-small">模考得分</div></div>
          </div>
          <div className="pv-card pv-streak"><Icon name="flame" size={18} /> 连续学习 12 天</div>
          <div className="pv-card pv-ai"><Icon name="spark" size={18} /><div><strong>AI 批改完成</strong><span>采分点 4 / 5 · 已生成错因分析</span></div></div>
        </div>
        {/* 这里原先写死「英语(二)/英语(专升本) · 课程代码 13000」。
            平台现在是多学科的，登录页在选学科之前，说不出具体是哪一门——
            写死任何一门，对另一门的学员就是错的。 */}
        <p className="tiny" style={{ opacity: .55 }}>登录后选择学科</p>
      </div>

      <div className="auth-panel">
        <form className="auth-form" onSubmit={onSubmit}>
          {/* 手机、平板上左边的品牌栏不显示，表单顶上补一个标记（PC 上藏起来，样式见 .auth-logo） */}
          <div className="auth-logo"><span className="brand-mark" aria-hidden="true">X</span>XLearn</div>
          <h2 style={{ fontSize: 24, marginBottom: 4, letterSpacing: '-.01em' }}>{admin ? '后台登录' : '欢迎回来'}</h2>
          <p className="small muted" style={{ marginTop: 0, marginBottom: 24 }}>
            {admin ? '仅超级管理员可进入' : '请使用管理员分配的账号登录'}
          </p>

          {error ? <div className="shake" style={{ marginBottom: 16 }}><Alert>{error}</Alert></div> : null}

          <div className="field">
            <label htmlFor="username">用户名</label>
            <div className="input-icon">
              <Icon name="user" size={18} />
              <input
                id="username" className="input" value={username} autoComplete="username"
                onChange={(e) => setUsername(e.target.value)} required
              />
            </div>
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <div className="input-icon">
              <Icon name="key" size={18} />
              <input
                id="password" className="input" type="password" value={password}
                autoComplete="current-password"
                onChange={(e) => setPassword(e.target.value)} required
              />
            </div>
          </div>

          <button className="btn block shimmer" type="submit" disabled={busy}>
            {busy ? <><span className="spinner light" /> 登录中…</> : <>登录 <Icon name="arrow" size={18} /></>}
          </button>

          <p className="tiny muted" style={{ marginTop: 20, textAlign: 'center' }}>
            {admin
              ? <a href="/login">返回学员入口</a>
              : <a href="/admin/login">管理员入口</a>}
          </p>
        </form>
      </div>
    </div>
  );
}

// 背景里缓缓上浮的学习符号：位置、速度、延迟错开，看起来不整齐
const GLYPHS = [
  { t: 'A', x: '6%', dur: '19s', delay: '-2s', size: 22 },
  { t: 'x²', x: '18%', dur: '24s', delay: '-11s', size: 18 },
  { t: '✓', x: '31%', dur: '21s', delay: '-6s', size: 20 },
  { t: 'B', x: '44%', dur: '26s', delay: '-15s', size: 16 },
  { t: 'π', x: '57%', dur: '22s', delay: '-3s', size: 24 },
  { t: '学', x: '69%', dur: '25s', delay: '-9s', size: 20 },
  { t: 'C', x: '81%', dur: '20s', delay: '-13s', size: 18 },
  { t: '∑', x: '92%', dur: '23s', delay: '-7s', size: 22 },
];
