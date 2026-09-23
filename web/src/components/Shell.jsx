import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { get } from '../api.js';
import { rememberSubject } from '../pages/SubjectPicker.jsx';

// 应用外壳：手机/平板抽屉导航，PC 侧边栏常驻（样式见 styles.css 的 1024px 断点）
export default function Shell({ nav, title, admin = false, subject = null, children }) {
  const [open, setOpen] = useState(false);
  const [subjects, setSubjects] = useState(null);
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // 兜底：换路由一定收起抽屉。正常路径上点导航时就已经关了（见下面的 onClick），
  // 这里管的是浏览器前进后退等不经过点击的跳转。
  useEffect(() => { setOpen(false); }, [location.pathname]);

  // 学科切换器的数据源。只在学科作用域下取；后台与改密页不需要。
  useEffect(() => {
    if (!subject) return;
    let cancelled = false;
    get('/me/subjects')
      .then((r) => { if (!cancelled) setSubjects(r.subjects); })
      // 取不到就不显示切换器。这是装饰性功能，失败不该把整个外壳弄挂——
      // 但也不静默改变主功能：当前学科该怎么用还是怎么用。
      .catch(() => { if (!cancelled) setSubjects([]); });
    return () => { cancelled = true; };
  }, [subject]);

  // 抽屉打开时锁定页面滚动
  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  function onLogout() {
    logout();
    navigate(admin ? '/admin/login' : '/login', { replace: true });
  }

  const menu = (
    <>
      <div className="nav-brand">
        <strong style={{ fontSize: 15 }}>{title}</strong>
        {/* 可访问学科 > 1 时才显示切换器。判断写"数量 > 1"而不是硬编码学科码，
            将来加学科不用回头改这里。 */}
        {subject && subjects && subjects.length > 1 ? (
          <select
            className="subject-switch"
            aria-label="切换学科"
            value={subject.code}
            onChange={(e) => {
              const code = e.target.value;
              if (code === subject.code) return;
              setOpen(false);
              if (code === '__pick__') { navigate('/app?pick=1'); return; }
              rememberSubject(code);
              navigate(`/app/${code}`);
            }}
          >
            {subjects.map((s) => (
              <option key={s.code} value={s.code} disabled={!s.ready && s.code !== subject.code}>
                {s.name}{s.ready ? '' : '（未开放）'}
              </option>
            ))}
            <option value="__pick__">全部学科…</option>
          </select>
        ) : null}
        {subject && subjects && subjects.length === 1 ? (
          <div className="tiny faint" style={{ marginTop: 4 }}>{subject.name}</div>
        ) : null}
      </div>
      <nav style={{ flex: 1 }}>
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="nav-foot">
        <div className="small" style={{ marginBottom: 10 }}>
          {user?.username}
          <span className="tiny faint" style={{ marginLeft: 6 }}>
            {user?.role === 'SUPER_ADMIN' ? '超级管理员' : '学员'}
          </span>
        </div>
        <button className="btn ghost sm block" onClick={onLogout}>退出登录</button>
      </div>
    </>
  );

  return (
    <div className={`shell${admin ? ' admin' : ''}`}>
      <aside className="sidebar">{menu}</aside>

      <div className="main">
        <header className="topbar">
          <button className="icon-btn" aria-label="打开菜单" onClick={() => setOpen(true)}>
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 6h18M3 12h18M3 18h18" strokeLinecap="round" />
            </svg>
          </button>
          <strong style={{ fontSize: 15 }}>{title}</strong>
        </header>

        {open ? (
          <>
            <div className="drawer-mask" onClick={() => setOpen(false)} />
            <aside className="drawer" style={{ display: 'flex', flexDirection: 'column' }}>{menu}</aside>
          </>
        ) : null}

        <div className="content">{children}</div>
      </div>
    </div>
  );
}
