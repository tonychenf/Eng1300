import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { Alert } from '../components/ui.jsx';

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
    <div className="auth-wrap">
      <div className="auth-brand">
        <div>
          <h1 style={{ fontSize: 30 }}>自考英语真题练习</h1>
          <p style={{ opacity: .8, maxWidth: 420, marginTop: 12 }}>
            按真题结构组卷、限时作答、错题解析与能力评估，帮你把每一分都拿稳。
          </p>
        </div>
        <p className="tiny" style={{ opacity: .55 }}>英语（一）00015 · 英语（二）13000</p>
      </div>

      <div className="auth-panel">
        <form className="auth-form" onSubmit={onSubmit}>
          <h2 style={{ fontSize: 22, marginBottom: 4 }}>{admin ? '后台登录' : '学员登录'}</h2>
          <p className="small muted" style={{ marginTop: 0, marginBottom: 24 }}>
            {admin ? '仅超级管理员可进入' : '请使用管理员分配的账号登录'}
          </p>

          {error ? <div style={{ marginBottom: 16 }}><Alert>{error}</Alert></div> : null}

          <div className="field">
            <label htmlFor="username">用户名</label>
            <input
              id="username" className="input" value={username} autoComplete="username"
              onChange={(e) => setUsername(e.target.value)} required
            />
          </div>
          <div className="field">
            <label htmlFor="password">密码</label>
            <input
              id="password" className="input" type="password" value={password}
              autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} required
            />
          </div>

          <button className="btn block" type="submit" disabled={busy}>
            {busy ? '登录中…' : '登录'}
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
