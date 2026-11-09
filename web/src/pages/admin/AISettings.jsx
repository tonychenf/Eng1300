import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';
import { formatBeijing } from '../../lib/time.js';

// 三档的分工按**喂给模型的是什么**分，不按学科分。
// 合法取值与回落链的唯一定义在 worker/src/lib/ai-purposes.js，这里只是配套的界面文案。
const PURPOSES = [
  {
    key: 'PARSING',
    title: '图片解析 AI',
    desc: '处理图片型原始资料：扫描件、拍照的卷子——把图转成文字再结构化。'
      + '**必须支持图片输入**。只传 docx 这类文字资料的话，这一档可以不配。',
  },
  {
    key: 'TEXT_PARSING',
    title: '文字解析 AI',
    desc: '处理文字型原始资料（docx、纯文本），并给「上传题库」传进来的题'
      + '生成候选答案与解析。不需要读图，所以可以用便宜得多的纯文本模型。'
      + '留空则沿用「图片解析 AI」——能跑，但视觉模型做纯文字活通常更贵更慢。',
  },
  {
    key: 'TUTORING',
    title: '教学 AI',
    desc: '批改主观题、生成错题解析与学习建议。'
      + '留空则依次沿用「文字解析 AI」「图片解析 AI」。',
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
      <p className="small" style={{ marginBottom: 12 }}>
        要比几个读图模型谁识别得准？<Link to="/admin/ai/ocr-bench" data-testid="ocr-bench-link">去做识别实测</Link>
      </p>
      <SpendCard />
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
                    <td data-label="用途">{PURPOSES.find((p) => p.key === r.purpose)?.title || r.purpose}</td>
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

const FEATURE_TEXT = {
  practice_point_grade: '练习批改', essay_grade: '模考批改', wrong_analyze: '错题分析',
  answer_generate: '出答案', answer_explain: '答案讲解', assessment: '能力评估', ocr: '识别', ocr_bench: '识别实测',
};

// 本月花费与每月上限（改进阶段 2 P1-C2、C3）。到上限只暂停错题分析，批改不停（用户 2026-11-07 定）
function SpendCard() {
  const [data, setData] = useState(null);
  const [yuan, setYuan] = useState('');
  const [msg, setMsg] = useState(null);
  const load = () => get('/admin/ai/spend').then((d) => {
    setData(d);
    setYuan(d.status?.budget == null ? '' : String(d.status.budget));
  });
  useEffect(() => { load().catch((e) => setMsg({ kind: 'error', text: e.message })); }, []);

  async function saveBudget() {
    setMsg(null);
    try {
      await put('/admin/ai/budget', { yuan: yuan.trim() === '' ? null : Number(yuan) });
      setMsg({ kind: 'success', text: '已保存' });
      await load();
    } catch (e) { setMsg({ kind: 'error', text: e.message }); }
  }

  if (!data) return null;
  const st = data.status;
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }} data-testid="spend-card">
      <h2 style={{ fontSize: 16, marginTop: 0 }}>本月 AI 花费（{data.month}）</h2>
      {msg ? <div style={{ marginBottom: 8 }}><Alert kind={msg.kind}>{msg.text}</Alert></div> : null}
      <p className="small">
        已花 <strong>{st?.spent ?? 0}</strong> 元
        {st?.budget != null ? ` / 上限 ${st.budget} 元` : '（没设上限）'}
        {st?.over ? <span className="badge danger" style={{ marginLeft: 8 }}>已到上限：错题分析暂停，批改照常</span> : null}
      </p>
      {st?.callsWithoutPrice ? (
        <p className="tiny" style={{ color: 'var(--warn)' }}>有 {st.callsWithoutPrice} 次调用的模型没填单价，花费不全。在下面每一档填上单价。</p>
      ) : null}
      {data.byFeature?.length ? (
        <div style={{ overflowX: 'auto' }}>
          <table className="table responsive">
            <thead><tr><th>功能</th><th>调用</th><th>失败</th><th>花费（元）</th></tr></thead>
            <tbody>
              {data.byFeature.map((r) => (
                <tr key={`${r.purpose}-${r.feature}`}>
                  <td data-label="功能">{FEATURE_TEXT[r.feature] || r.feature || r.purpose}</td>
                  <td data-label="调用">{r.calls}</td>
                  <td data-label="失败">{r.failed || 0}</td>
                  <td data-label="花费（元）">{r.cost == null ? '缺单价' : r.cost}{r.without_price && r.cost != null ? '（部分缺单价）' : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : <p className="tiny muted">这个月还没有调用。</p>}
      <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '1 1 160px', marginBottom: 0 }}>
          <label htmlFor="budget-yuan">每月上限（元，空 = 不设）</label>
          <input id="budget-yuan" className="input" inputMode="decimal" value={yuan} onChange={(e) => setYuan(e.target.value)} />
        </div>
        <button className="btn sm" style={{ alignSelf: 'flex-end' }} onClick={saveBudget} data-testid="budget-save">保存上限</button>
      </div>
      <p className="tiny faint" style={{ marginBottom: 0 }}>到了上限：练习和模考的批改照常；错题分析暂停；后台出答案要你确认才继续。</p>
    </div>
  );
}

function PurposeCard({ meta, value, onSaved }) {
  const [form, setForm] = useState({
    baseUrl: value?.baseUrl || '',
    model: value?.model || '',
    apiKey: '',
    visionCapable: value?.visionCapable ?? (meta.key === 'PARSING'),
    priceInPerM: value?.priceInPerM ?? '',
    priceOutPerM: value?.priceOutPerM ?? '',
  });
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState(null);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    setBusy('save'); setMsg(null);
    try {
      await put(`/admin/ai/settings/${meta.key}`, {
        ...form,
        // 空着 = 没填单价（花费页按"缺单价"提示），不当 0
        priceInPerM: form.priceInPerM === '' ? null : Number(form.priceInPerM),
        priceOutPerM: form.priceOutPerM === '' ? null : Number(form.priceOutPerM),
      });
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
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <div className="field" style={{ flex: '1 1 140px' }}>
          <label htmlFor={`${meta.key}-pin`}>输入单价（元 / 百万 tokens）</label>
          <input id={`${meta.key}-pin`} className="input" inputMode="decimal" value={form.priceInPerM}
            placeholder="按服务商价目表填，免费填 0" onChange={(e) => set('priceInPerM', e.target.value)} />
        </div>
        <div className="field" style={{ flex: '1 1 140px' }}>
          <label htmlFor={`${meta.key}-pout`}>输出单价（元 / 百万 tokens）</label>
          <input id={`${meta.key}-pout`} className="input" inputMode="decimal" value={form.priceOutPerM}
            placeholder="按服务商价目表填，免费填 0" onChange={(e) => set('priceOutPerM', e.target.value)} />
        </div>
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
      {value?.updatedAt ? <p className="tiny faint" style={{ marginBottom: 0 }}>最近更新：{formatBeijing(value.updatedAt)}</p> : null}
    </div>
  );
}
