import { useEffect, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../auth.jsx';
import { get } from '../api.js';
import { rememberSubject } from '../pages/SubjectPicker.jsx';
import { Icon } from './icons.jsx';

// 应用外壳（样式见 styles.css 的「应用外壳」一节）：
//   PC（≥1024px）：侧边栏常驻，带图标；
//   手机 / 平板，学员端：顶部只留标题，常用的几项放底部标签栏（导航项带 tab: true 的），其余收进「更多」（底部弹层）；
//   手机 / 平板，后台：顶栏左边汉堡按钮打开侧边抽屉（后台项目多、主要在电脑上用）。
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

  const tabs = admin ? [] : nav.filter((n) => n.tab);
  const initial = String(user?.username || '?').slice(0, 1).toUpperCase();

  const menu = (
    <>
      <div className="nav-brand">
        <span className="brand-mark" aria-hidden="true">X</span>
        <div className="nav-brand-text">
          <strong>{title}</strong>
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
          ) : (
            <span className="tiny faint">{admin ? 'XLearn 管理后台' : 'XLearn'}</span>
          )}
        </div>
      </div>
      <nav className="nav-list">
        {nav.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            onClick={() => setOpen(false)}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            {item.icon ? <Icon name={item.icon} size={18} /> : null}
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      <div className="nav-foot">
        <div className="user-chip">
          <span className="avatar" aria-hidden="true">{initial}</span>
          <div style={{ minWidth: 0 }}>
            <div className="small user-name">{user?.username}</div>
            <div className="tiny faint">{user?.role === 'SUPER_ADMIN' ? '超级管理员' : '学员'}</div>
          </div>
        </div>
        <button className="btn ghost sm block" onClick={onLogout}>
          <Icon name="logout" size={16} /> 退出登录
        </button>
      </div>
    </>
  );

  return (
    <div className={`shell${admin ? ' admin' : ''}${tabs.length ? ' has-tabbar' : ''}`}>
      <aside className="sidebar">{menu}</aside>

      <div className="main">
        <header className="topbar">
          {admin ? (
            <button className="icon-btn" aria-label="打开菜单" onClick={() => setOpen(true)}>
              <Icon name="menu" size={22} />
            </button>
          ) : <span className="brand-mark sm" aria-hidden="true">X</span>}
          <strong className="topbar-title">{title}</strong>
          {!admin ? (
            <button className="avatar-btn" aria-label="打开菜单" onClick={() => setOpen(true)}>
              <span className="avatar" aria-hidden="true">{initial}</span>
            </button>
          ) : null}
        </header>

        {open ? (
          <>
            <div className="drawer-mask" onClick={() => setOpen(false)} />
            <aside className={`drawer${admin ? '' : ' sheet'}`} role="dialog" aria-label="菜单">
              {!admin ? <div className="sheet-grip" aria-hidden="true" /> : null}
              {menu}
            </aside>
          </>
        ) : null}

        <div className="content">{children}</div>
      </div>

      {tabs.length ? (
        <nav className="tabbar" aria-label="主要功能">
          {tabs.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
            >
              <Icon name={item.icon} size={22} />
              <span>{item.tabLabel || item.label}</span>
            </NavLink>
          ))}
          <button type="button" className={`tab${open ? ' active' : ''}`} onClick={() => setOpen(true)}>
            <Icon name="more" size={22} />
            <span>更多</span>
          </button>
        </nav>
      ) : null}
    </div>
  );
}
