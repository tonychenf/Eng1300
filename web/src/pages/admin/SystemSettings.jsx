import { useEffect, useState } from 'react';
import { get, put } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

export default function SystemSettings() {
  const [rows, setRows] = useState(null);
  const [draft, setDraft] = useState({});
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    get('/admin/settings').then((r) => {
      setRows(r.settings);
      setDraft(Object.fromEntries(r.settings.map((s) => [s.key, s.value])));
    }).catch((e) => setMsg({ kind: 'error', text: e.message }));
  }, []);

  async function saveOne(key) {
    setMsg(null);
    try {
      await put(`/admin/settings/${key}`, { value: draft[key] });
      setRows((prev) => prev.map((s) => (s.key === key ? { ...s, value: draft[key] } : s)));
      setMsg({ kind: 'success', text: `已保存 ${key}` });
    } catch (e) {
      setMsg({ kind: 'error', text: e.message });
    }
  }

  if (!rows) return <Loading />;

  return (
    <>
      <PageHead title="系统参数" desc="考试时长等全局参数，改动立即对新会话生效" />
      {msg ? <div style={{ marginBottom: 12 }}><Alert kind={msg.kind}>{msg.text}</Alert></div> : null}

      <div className="stack">
        {rows.map((s) => {
          const dirty = draft[s.key] !== s.value;
          return (
            <div className="card card-pad" key={s.key}>
              <label htmlFor={s.key} style={{ display: 'block', fontWeight: 600, marginBottom: 2 }}>
                {s.description || s.key}
              </label>
              <p className="tiny mono faint" style={{ marginTop: 0 }}>{s.key}</p>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <input id={s.key} className="input" value={draft[s.key] ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, [s.key]: e.target.value }))} />
                <button className="btn sm" onClick={() => saveOne(s.key)} disabled={!dirty}>保存</button>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
