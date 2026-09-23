import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { get, put } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

// 单人视角：一个学员能进哪些学科。
// 新学员入学时一次给他开好几个学科，用这一页。
export default function UserSubjects() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [picked, setPicked] = useState(new Set());
  const [expires, setExpires] = useState({});
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    get(`/admin/users/${id}/subjects`).then((r) => {
      setData(r);
      setPicked(new Set(r.subjects.filter((s) => s.grant_status === 'ACTIVE').map((s) => s.code)));
      setExpires(Object.fromEntries(
        r.subjects.filter((s) => s.expires_at).map((s) => [s.code, s.expires_at.slice(0, 10)])));
    }).catch((e) => setError(e.message));
  }, [id]);

  function toggle(code) {
    setPicked((prev) => {
      const next = new Set(prev);
      next.has(code) ? next.delete(code) : next.add(code);
      return next;
    });
  }

  async function save() {
    setBusy(true); setError(''); setMsg('');
    try {
      // 提交的是完整集合：没勾的一律撤销。界面本来就是一组勾选框，
      // 提交全集比"发一次增量再发一次删除"少一步、也漏不掉。
      const subjects = [...picked].map((code) => ({
        code,
        expiresAt: expires[code] ? `${expires[code]} 23:59:59` : null,
      }));
      const r = await put(`/admin/users/${id}/subjects`, { subjects });
      setMsg(`已开通 ${r.granted} 个、更新 ${r.updated} 个、撤销 ${r.revoked} 个`);
      const fresh = await get(`/admin/users/${id}/subjects`);
      setData(fresh);
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;

  return (
    <>
      <PageHead
        title={`${data.user.username} 的学科`}
        desc="勾选这个账号可以进入的学科。取消勾选即撤销，撤销立即生效。"
        actions={<Link className="btn ghost sm" to="/admin/users">返回账号管理</Link>}
      />
      {error ? <Alert>{error}</Alert> : null}
      {msg ? <div className="card card-pad" style={{ marginBottom: 12 }}>{msg}</div> : null}

      {data.adminBypass ? (
        <div className="card card-pad">
          <p style={{ margin: 0 }}>
            <strong>{data.user.username}</strong> 是超级管理员，本来就能访问所有学科，
            不需要也不能单独授权。
          </p>
        </div>
      ) : (
        <>
          <div className="card card-pad" style={{ marginBottom: 16 }}>
            <div className="stack">
              {data.subjects.map((s) => (
                <div key={s.code} className="spread" style={{ alignItems: 'flex-start', gap: 12 }}>
                  <label className="small" style={{ flex: 1, display: 'flex', gap: 8, minHeight: 44, alignItems: 'center' }}>
                    <input
                      type="checkbox"
                      checked={picked.has(s.code)}
                      onChange={() => toggle(s.code)}
                    />
                    <span>
                      <strong>{s.name}</strong>
                      <span className="tiny faint" style={{ marginLeft: 6 }}>{s.code}</span>
                      {s.subject_status === '停用'
                        ? <span className="badge" style={{ marginLeft: 6 }}>学科已停用</span> : null}
                      {s.granted_at ? (
                        <div className="tiny faint">
                          {s.granted_by_name ? `${s.granted_by_name} 于 ` : ''}{s.granted_at} 开通
                        </div>
                      ) : null}
                    </span>
                  </label>
                  {picked.has(s.code) ? (
                    <label className="tiny faint" style={{ textAlign: 'right' }}>
                      到期日（留空为长期）
                      <input
                        type="date"
                        value={expires[s.code] || ''}
                        onChange={(e) => setExpires({ ...expires, [s.code]: e.target.value })}
                        style={{ display: 'block', fontSize: 16, minHeight: 44 }}
                      />
                    </label>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
          <button className="btn" onClick={save} disabled={busy}>
            {busy ? '保存中…' : '保存'}
          </button>
          <p className="small muted" style={{ marginTop: 16 }}>
            撤销之后这个账号立刻进不去该学科，历史记录与错题本里该学科的数据也不再显示；
            数据本身保留，重新开通即可恢复。
          </p>
        </>
      )}
    </>
  );
}
