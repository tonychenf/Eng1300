import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, get, post } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

// 单学科视角：这个学科有哪些成员。
// 新学科开课时一次给一批学员开通，用这一页。
export default function SubjectMembers() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [audit, setAudit] = useState([]);
  const [names, setNames] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);

  const load = async () => {
    const [m, a] = await Promise.all([
      get(`/admin/subjects/${id}/members`),
      // 审计是辅助信息，取不到不该让整页打不开
      get('/admin/grants/audit?limit=20').catch(() => ({ entries: [] })),
    ]);
    setData(m); setAudit(a.entries);
  };
  useEffect(() => { load().catch((e) => setError(e.message)); }, [id]);

  async function grant(e) {
    e.preventDefault();
    setError(''); setResult(null);
    // 一行一个，或用逗号/空格分隔——粘贴名单时不该强迫人先整理格式
    const usernames = names.split(/[\s,，、]+/).map((s) => s.trim()).filter(Boolean);
    if (!usernames.length) { setError('请先填要开通的用户名'); return; }
    try {
      const r = await post(`/admin/subjects/${id}/members`, {
        usernames,
        expiresAt: expiresAt ? `${expiresAt} 23:59:59` : null,
      });
      setResult(r);
      setNames('');
      await load();
    } catch (err) { setError(err.message); }
  }

  async function revoke(u) {
    if (!confirm(`确认撤销 ${u.username} 对本学科的访问？\n\n立即生效。数据保留，重新开通即可恢复。`)) return;
    setError(''); setResult(null);
    try {
      await api(`/admin/subjects/${id}/members/${u.id}`, { method: 'DELETE' });
      await load();
    } catch (err) { setError(err.message); }
  }

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;

  return (
    <>
      <PageHead
        title={`${data.subject.name} · 成员`}
        desc={`全平台 ${data.studentTotal} 个学员账号，其中 ${data.members.length} 个已开通本学科`}
        actions={<Link className="btn ghost sm" to="/admin/subjects">返回学科管理</Link>}
      />
      {error ? <Alert>{error}</Alert> : null}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>批量开通</h2>
        <form onSubmit={grant} className="stack">
          <label className="small">
            用户名
            <textarea
              rows={3} value={names} onChange={(e) => setNames(e.target.value)}
              placeholder="一行一个，也可以用逗号或空格分隔"
              style={{ fontSize: 16, width: '100%' }}
            />
            <span className="tiny faint">
              找不到的用户名会单独列出来，其余照常开通——不会因为一个名字打错就整批不生效。
            </span>
          </label>
          <label className="small">
            统一到期日（留空为长期有效）
            <input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)}
                   style={{ fontSize: 16, minHeight: 44 }} />
          </label>
          <div><button className="btn sm" type="submit">开通</button></div>
        </form>
        {result ? (
          <div className="small" style={{ marginTop: 12 }}>
            已开通 <strong>{result.granted}</strong> 个。
            {result.notFound?.length
              ? <> 没找到这些用户名：<strong>{result.notFound.join('、')}</strong>。</> : null}
            {result.skippedAdmins?.length
              ? <> 跳过管理员（本就通吃）：{result.skippedAdmins.join('、')}。</> : null}
          </div>
        ) : null}
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 15, marginTop: 0 }}>已开通（{data.members.length}）</h2>
        {!data.members.length ? (
          <p className="small muted">还没有人开通本学科。</p>
        ) : (
          <div className="stack">
            {data.members.map((u) => (
              <div key={u.id} className="spread" style={{ minHeight: 44, alignItems: 'center' }}>
                <span className="small">
                  <strong>{u.username}</strong>
                  {u.disabled ? <span className="badge" style={{ marginLeft: 6 }}>账号已停用</span> : null}
                  {u.status === 'SUSPENDED'
                    ? <span className="badge" style={{ marginLeft: 6 }}>授权已暂停</span> : null}
                  <span className="tiny faint" style={{ marginLeft: 6 }}>
                    {u.expires_at ? `${u.expires_at.slice(0, 10)} 到期` : '长期'}
                  </span>
                </span>
                <span className="row">
                  <Link className="btn ghost sm" to={`/admin/users/${u.id}/subjects`}>按人管理</Link>
                  <button className="btn ghost sm" onClick={() => revoke(u)}>撤销</button>
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card card-pad">
        <h2 style={{ fontSize: 15, marginTop: 0 }}>最近的授权变更（全平台）</h2>
        {!audit.length ? <p className="small muted">还没有记录。</p> : (
          <div className="stack">
            {audit.map((e) => (
              <div key={e.id} className="tiny">
                <span className="faint">{e.created_at}</span>{' '}
                <strong>{e.actor || '（已删除账号）'}</strong>{' '}
                {e.action === 'GRANT' ? '开通了' : e.action === 'REVOKE' ? '撤销了' : '修改了'}{' '}
                <strong>{e.target}</strong> 的「{e.subject_name || e.subject_code}」
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
