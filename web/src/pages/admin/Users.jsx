import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, patch, post } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

export default function Users() {
  const [users, setUsers] = useState(null);
  const [username, setUsername] = useState('');
  const [error, setError] = useState('');
  // 新建/重置后一次性展示的明文密码，刷新即消失
  const [credential, setCredential] = useState(null);

  const load = () => get('/admin/users').then((r) => setUsers(r.users)).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function create(e) {
    e.preventDefault();
    setError(''); setCredential(null);
    try {
      const r = await post('/admin/users', { username: username.trim() });
      setCredential({ id: r.user.id, username: r.user.username, password: r.initialPassword });
      setUsername('');
      await load();
    } catch (err) { setError(err.message); }
  }

  async function reset(u) {
    if (!confirm(`确认重置 ${u.username} 的密码？原密码立即失效。`)) return;
    setError(''); setCredential(null);
    try {
      const r = await post(`/admin/users/${u.id}/reset-password`);
      setCredential({ username: u.username, password: r.newPassword });
    } catch (err) { setError(err.message); }
  }

  async function toggle(u) {
    setError('');
    try {
      await patch(`/admin/users/${u.id}/status`, { disabled: !u.disabled });
      await load();
    } catch (err) { setError(err.message); }
  }

  return (
    <>
      <PageHead title="账号管理" desc="学员账号的创建、停用与密码重置" />

      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {credential ? (
        <PasswordDialog cred={credential} onClose={() => setCredential(null)} />
      ) : null}

      <form className="card card-pad" style={{ marginBottom: 16 }} onSubmit={create}>
        <label className="small" style={{ display: 'block', marginBottom: 6 }}>新建学员账号</label>
        <div className="row" style={{ flexWrap: 'nowrap' }}>
          <input className="input" value={username} placeholder="用户名，如 T011"
            onChange={(e) => setUsername(e.target.value)} required />
          <button className="btn" type="submit">创建</button>
        </div>
        <p className="tiny muted" style={{ marginBottom: 0 }}>3–20 位字母、数字或下划线；初始密码由系统随机生成。</p>
      </form>

      {!users ? <Loading /> : (
        <div className="card" style={{ overflowX: 'auto' }}>
          <table className="table responsive">
            <thead>
              <tr><th>用户名</th><th>角色</th><th>状态</th><th>最近登录</th><th></th></tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td data-label="用户名"><strong>{u.username}</strong></td>
                  <td data-label="角色">{u.role === 'SUPER_ADMIN' ? '超级管理员' : '学员'}</td>
                  <td data-label="状态">
                    {u.disabled
                      ? <span className="badge danger">已停用</span>
                      : <span className="badge ok">正常</span>}
                  </td>
                  <td data-label="最近登录">
                    <span className="small muted">{u.last_login_at || '从未登录'}</span>
                  </td>
                  <td data-label="">
                    <div className="row">
                      {u.role === 'SUPER_ADMIN' ? null : (
                        <Link className="btn ghost sm" to={`/admin/users/${u.id}/subjects`}>学科</Link>
                      )}
                      <button className="btn ghost sm" onClick={() => reset(u)}>重置密码</button>
                      {u.role === 'SUPER_ADMIN' ? null : (
                        <button className={`btn sm ${u.disabled ? 'ghost' : 'danger'}`} onClick={() => toggle(u)}>
                          {u.disabled ? '启用' : '停用'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

// 一次性口令弹窗（N7a）。
//
// 这段的全部意义是**让管理员不可能错过它**。原先是表格上方的一条横幅，
// 而重置按钮在表格每一行：学员一多，点下面那行的重置，口令渲染在滚动区外，
// 管理员看到的是"点了没反应"，然后刷新页面——口令只生成一次、不可找回，
// 那个账号就此登不进去，只能再重置一次，再错过一次。
//
// 所以用原生 <dialog> 的模态形态：它会把焦点收进来、Esc 可关、背景遮罩由浏览器画。
// 关闭按钮写成"我已记下并转交"，因为这件事没做完，重置就等于没做。
function PasswordDialog({ cred, onClose }) {
  const ref = useRef(null);
  const [copied, setCopied] = useState('');

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(cred.password);
      setCopied('已复制到剪贴板');
    } catch {
      // http 或旧浏览器下 clipboard 不可用。不要假装成功——
      // 管理员以为复制到了，粘贴出来是空的，口令就丢了。
      setCopied('这个浏览器不让自动复制，请手动选中上面的口令');
    }
  }

  return (
    <dialog ref={ref} className="pw-dialog" onClose={onClose}>
      <div className="pw-body">
        <h2 style={{ fontSize: 18, marginTop: 0, marginBottom: 6 }}>
          {cred.id ? '账号已创建' : '密码已重置'}
        </h2>
        <p className="small" style={{ marginTop: 0 }}>
          <strong>{cred.username}</strong> 的{cred.id ? '初始' : '新'}密码是：
        </p>

        <div className="pw-code">
          <code>{cred.password}</code>
          <button className="btn ghost sm" type="button" onClick={copy}>复制</button>
        </div>
        {copied ? <p className="tiny" style={{ marginTop: -4 }}>{copied}</p> : null}

        <p className="small" style={{ color: 'var(--warn)' }}>
          <strong>请把这串口令转交给 {cred.username} 本人。</strong>
          它只显示这一次，关掉之后任何人都查不回来——包括你。真丢了只能再重置一次。
        </p>

        {/* 新建的账号默认没有任何学科授权，什么都打不开。忘了这一步不会报错——
            学员只会看到"管理员尚未为你开通任何学科"，然后来问。这里直接给入口。 */}
        {cred.id ? (
          <p className="small">
            这个账号还没有任何学科权限，
            <Link to={`/admin/users/${cred.id}/subjects`}>去开通学科</Link>
            {' '}之后学员才能用。
          </p>
        ) : null}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 16 }}>
          <button className="btn" type="button" onClick={() => ref.current?.close()}>
            我已记下并转交
          </button>
        </div>
      </div>
    </dialog>
  );
}
