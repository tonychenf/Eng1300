import { useEffect, useState } from 'react';
import { get, post, put } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

const PURPOSES = [
  {
    key: 'PARSING',
    title: '解析 AI',
    desc: '用于把上传的真题图片转成文字，并结构化、标注考点。需要支持图片输入。',
  },
  {
    key: 'TUTORING',
    title: '教学 AI',
    desc: '用于批改主观题、生成错题解析与学习建议。留空则复用解析 AI 的配置。',
  },
];

export default function AISettings() {
  const [settings, setSettings] = useState(null);
  const [usage, setUsage] = useState(null);

  const load = () => get('/admin/ai/settings').then((r) => setSettings(r.settings));
  useEffect(() => {
    load().catch(() => setSettings({}));
    get('/admin/ai/usage').then(setUsage).catch(() => {});
  }, []);

  if (!settings) return <Loading />;

  return (
    <>
      <PageHead title="AI 配置" desc="接口地址、模型与密钥。密钥加密存储，保存后只回显尾号。" />
      <div className="stack">
        {PURPOSES.map((p) => (
          <PurposeCard key={p.key} meta={p} value={settings[p.key]} onSaved={load} />
        ))}
      </div>

      {usage?.byPurpose?.length ? (
        <div className="card card-pad" style={{ marginTop: 20 }}>
          <h2 style={{ fontSize: 16, marginBottom: 12 }}>近 30 天调用量</h2>
          <div style={{ overflowX: 'auto' }}>
            <table className="table responsive">
              <thead>
                <tr><th>用途</th><th>调用</th><th>成功</th><th>输入 token</th><th>输出 token</th><th>平均耗时</th></tr>
              </thead>
              <tbody>
                {usage.byPurpose.map((r) => (
                  <tr key={r.purpose}>
                    <td data-label="用途">{r.purpose === 'PARSING' ? '解析 AI' : '教学 AI'}</td>
                    <td data-label="调用">{r.calls}</td>
                    <td data-label="成功">{r.ok_calls || 0}</td>
                    <td data-label="输入 token">{r.tokens_in || 0}</td>
                    <td data-label="输出 token">{r.tokens_out || 0}</td>
                    <td data-label="平均耗时">{r.avg_latency_ms || 0} ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </>
  );
}

function PurposeCard({ meta, value, onSaved }) {
  const [form, setForm] = useState({
    baseUrl: value?.baseUrl || '',
    model: value?.model || '',
    apiKey: '',
    visionCapable: value?.visionCapable ?? (meta.key === 'PARSING'),
  });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy('save'); setMsg(null);
    try {
      await put(`/admin/ai/settings/${meta.key}`, form);
      set('apiKey', '');
      setMsg({ kind: 'success', text: '已保存' });
      await onSaved();
    } catch (e) {
      setMsg({ kind: 'error', text: e.message });
    } finally { setBusy(''); }
  }

  async function test() {
    setBusy('test'); setMsg(null);
    try {
      const r = await post(`/admin/ai/settings/${meta.key}/test`);
      const parts = [];
      if (r.result?.text) {
        parts.push(r.result.text.ok
          ? `文本 ✓ ${r.result.text.latencyMs}ms`
          : `文本 ✗ ${r.result.text.error}`);
      }
      if (r.result?.vision) {
        parts.push(r.result.vision.ok
          ? `图片 ✓ ${r.result.vision.latencyMs}ms`
          : `图片 ✗ ${r.result.vision.error}`);
      }
      setMsg({ kind: r.ok ? 'success' : 'error', text: parts.join(' · ') });
    } catch (e) {
      setMsg({ kind: 'error', text: e.message });
    } finally { setBusy(''); }
  }

  return (
    <div className="card card-pad">
      <div className="spread" style={{ marginBottom: 4 }}>
        <h2 style={{ fontSize: 16 }}>{meta.title}</h2>
        {value?.hasKey
          ? <span className="badge ok">已配置</span>
          : <span className="badge gray">未配置</span>}
      </div>
      <p className="tiny muted" style={{ marginTop: 0 }}>{meta.desc}</p>

      {msg ? <div style={{ marginBottom: 12 }}><Alert kind={msg.kind}>{msg.text}</Alert></div> : null}

      <div className="field">
        <label htmlFor={`${meta.key}-url`}>接口地址</label>
        <input id={`${meta.key}-url`} className="input" value={form.baseUrl}
          placeholder="https://api.siliconflow.cn/v1"
          onChange={(e) => set('baseUrl', e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${meta.key}-model`}>模型</label>
        <input id={`${meta.key}-model`} className="input" value={form.model}
          placeholder={meta.key === 'PARSING' ? 'deepseek-ai/DeepSeek-OCR' : 'Qwen/Qwen3-8B'}
          onChange={(e) => set('model', e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`${meta.key}-key`}>API Key</label>
        <input id={`${meta.key}-key`} className="input" type="password" value={form.apiKey}
          autoComplete="new-password"
          placeholder={value?.hasKey ? `留空则保持不变（当前 ${value.apiKeyMasked}）` : 'sk-…'}
          onChange={(e) => set('apiKey', e.target.value)} />
      </div>
      <label className="row" style={{ flexWrap: 'nowrap', minHeight: 44 }}>
        <input type="checkbox" checked={form.visionCapable} style={{ width: 18, height: 18 }}
          onChange={(e) => set('visionCapable', e.target.checked)} />
        <span className="small">该模型支持图片输入</span>
      </label>

      <div className="row" style={{ marginTop: 12 }}>
        <button className="btn" onClick={save} disabled={Boolean(busy)}>
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
        <button className="btn ghost" onClick={test} disabled={Boolean(busy) || !value?.hasKey}>
          {busy === 'test' ? '测试中…' : '连通性测试'}
        </button>
      </div>
      {value?.updatedAt ? <p className="tiny faint" style={{ marginBottom: 0 }}>最近更新：{value.updatedAt}</p> : null}
    </div>
  );
}
