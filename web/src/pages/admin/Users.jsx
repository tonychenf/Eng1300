import { useEffect, useState } from 'react';
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
      setCredential({ username: r.user.username, password: r.initialPassword });
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
        <div style={{ marginBottom: 16 }}>
          <Alert kind="success">
            <div><strong>{credential.username}</strong> 的密码：
              <code className="mono" style={{ fontSize: 15 }}>{credential.password}</code>
            </div>
            <div className="tiny" style={{ marginTop: 4 }}>
              密码只在此处显示一次，请立即复制转交，页面刷新后无法找回。
            </div>
          </Alert>
        </div>
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
