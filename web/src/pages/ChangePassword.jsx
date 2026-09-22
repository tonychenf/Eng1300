import { useState } from 'react';
import { post } from '../api.js';
import { Alert, PageHead } from '../components/ui.jsx';

export default function ChangePassword() {
  const [form, setForm] = useState({ currentPassword: '', newPassword: '', confirm: '' });
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function onSubmit(e) {
    e.preventDefault();
    setMsg(null);
    if (form.newPassword !== form.confirm) {
      setMsg({ kind: 'error', text: '两次输入的新密码不一致' });
      return;
    }
    setBusy(true);
    try {
      await post('/me/password', {
        currentPassword: form.currentPassword,
        newPassword: form.newPassword,
      });
      setForm({ currentPassword: '', newPassword: '', confirm: '' });
      setMsg({ kind: 'success', text: '密码已修改，下次登录请使用新密码' });
    } catch (err) {
      setMsg({ kind: 'error', text: err.message });
    } finally { setBusy(false); }
  }

  return (
    <>
      <PageHead title="修改密码" desc="新密码至少 8 位，需同时包含字母和数字" />
      <form className="card card-pad" style={{ maxWidth: 460 }} onSubmit={onSubmit}>
        {msg ? <div style={{ marginBottom: 12 }}><Alert kind={msg.kind}>{msg.text}</Alert></div> : null}
        <div className="field">
          <label htmlFor="cur">当前密码</label>
          <input id="cur" className="input" type="password" autoComplete="current-password"
            value={form.currentPassword} onChange={(e) => set('currentPassword', e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="new">新密码</label>
          <input id="new" className="input" type="password" autoComplete="new-password"
            value={form.newPassword} onChange={(e) => set('newPassword', e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="confirm">确认新密码</label>
          <input id="confirm" className="input" type="password" autoComplete="new-password"
            value={form.confirm} onChange={(e) => set('confirm', e.target.value)} required />
        </div>
        <button className="btn" type="submit" disabled={busy}>{busy ? '提交中…' : '修改密码'}</button>
      </form>
    </>
  );
}
