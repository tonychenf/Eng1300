import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';

// 应用外壳：手机/平板抽屉导航，PC 侧边栏常驻（样式见 styles.css 的 1024px 断点）
export default function Shell({ nav, title, admin = false, children }) {
  const [open, setOpen] = useState(false);
  const { user, logout } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  // 兜底：换路由一定收起抽屉。正常路径上点导航时就已经关了（见下面的 onClick），
  // 这里管的是浏览器前进后退等不经过点击的跳转。
  useEffect(() => { setOpen(false); }, [location.pathname]);

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
