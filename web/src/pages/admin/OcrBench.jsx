import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';
import { formatBeijing } from '../../lib/time.js';
// 标准答案和比对算法放在 worker 那边（第三期导入时服务端也要用），页面直接引同一份
import { evaluate, shortLine, TRUTH_PAGES, UNAVAILABLE } from '../../../../worker/src/ocr-bench/evaluate.js';

// 识别实测（改进阶段 2 第二期，PRD 第 6 节）。
//   ① 选几张照片、每张标上原书页码；选要比的模型（带单价）和压缩尺寸；
//   ② 先看预估：几次识别、大概多少钱 → 点"开始"；
//   ③ 浏览器压缩图片、一张张送去识别（图只在那一次请求里，服务端不留），回来的文字和转写稿逐字比；
//   ④ 出报告：每个模型 × 尺寸的字符准确率、题目完整率、体检检出率 / 误报率、耗时、花费，可导出。

const THRESHOLD = { accuracy: 0.995, completeness: 1 };   // BRD 第 0 节的上线门槛
const LIKELY_VISION = /(vl|ocr|vision|omni|qvq|internvl|janus|glm-4(\.\d)?v|pixtral|llava|gemma-3)/i;
const CONCURRENCY = 2;
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);
const yuan = (x) => (x == null ? '—' : `${Number(x).toFixed(4)} 元`);

const PAGE_OPTIONS = [
  ...TRUTH_PAGES.map((p) => ({ page: p.page, label: `第 ${p.page} 页 · ${p.label}` })),
  ...Object.entries(UNAVAILABLE).map(([pg, why]) => ({ page: Number(pg), label: `第 ${pg} 页 · ${why}（只记耗时花费）` })),
  // 第 141–153 页是第三期真要导的、扫描件和转写稿里都没有：能测、只看体检和耗时花费
  ...Array.from({ length: 13 }, (_, i) => 141 + i).map((pg) => ({ page: pg, label: `第 ${pg} 页 · 没有转写稿（只记耗时花费）` })),
].sort((a, b) => a.page - b.page);

// 压缩到长边 size（不放大），JPEG。手机照片带方向信息，按图片本身的方向画
async function compress(file, size) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, size / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale);
  const h = Math.round(bmp.height * scale);
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  cv.getContext('2d').drawImage(bmp, 0, 0, w, h);
  bmp.close?.();
  return { dataUrl: cv.toDataURL('image/jpeg', 0.85), w, h };
}
async function dims(file) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const d = { w: bmp.width, h: bmp.height };
  bmp.close?.();
  return d;
}

// 预估：输入 ≈ 图片 tokens（按 28×28 一块估）+ 提示词；输出 ≈ 标准答案字数（找不到按 1500）
function estimateCall({ w, h }, size, page) {
  const s = Math.min(1, size / Math.max(w, h));
  const tin = Math.ceil((w * s) / 28) * Math.ceil((h * s) / 28) + 150;
  const tp = TRUTH_PAGES.find((p) => p.page === page);
  const tout = tp?.text ? Math.ceil(tp.text.length / 2) : 1500;
  return { tin, tout };
}

export default function OcrBench() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);       // [{ key, file, name, page, w, h }]
  const [models, setModels] = useState([]);     // [{ id, priceInPerM, priceOutPerM }]
  const [extra, setExtra] = useState('');
  const [sizes, setSizes] = useState([1600, 2400]);
  const [run, setRun] = useState(null);         // { id, config, results }
  const [progress, setProgress] = useState(null);
  const [past, setPast] = useState([]);
  const fileRef = useRef(null);

  const loadPast = () => get('/admin/ai/ocr-bench').then((r) => setPast(r.runs || [])).catch(() => {});
  useEffect(() => {
    get('/admin/ai/ocr-bench/config').then((c) => {
      setCfg(c);
      if (c.provider?.model) {
        setModels([{ id: c.provider.model, priceInPerM: c.provider.priceInPerM ?? '', priceOutPerM: c.provider.priceOutPerM ?? '' }]);
      }
    }).catch((e) => setError(e.message));
    loadPast();
  }, []);

  const suggestions = useMemo(() => (cfg?.models || []).filter((m) => LIKELY_VISION.test(m)), [cfg]);
  const toggleModel = (id) => setModels((ms) => (ms.some((m) => m.id === id)
    ? ms.filter((m) => m.id !== id)
    : [...ms, { id, priceInPerM: id === cfg?.provider?.model ? (cfg.provider.priceInPerM ?? '') : '', priceOutPerM: id === cfg?.provider?.model ? (cfg.provider.priceOutPerM ?? '') : '' }]));
  const setPrice = (id, k, v) => setModels((ms) => ms.map((m) => (m.id === id ? { ...m, [k]: v } : m)));

  async function addFiles(list) {
    const next = [];
    for (const f of list) {
      try {
        const d = await dims(f);
        next.push({ key: `${f.name}-${f.size}-${Math.random()}`, file: f, name: f.name, page: '', ...d });
      } catch {
        setError(`「${f.name}」读不出来（手机上的 HEIC 照片请在相册里存成 JPEG 再选）`);
      }
    }
    setItems((xs) => [...xs, ...next].slice(0, 10));
  }

  const calls = items.length * models.length * sizes.length;
  const est = useMemo(() => {
    let total = 0;
    let unknown = false;
    for (const it of items) for (const s of sizes) for (const m of models) {
      const { tin, tout } = estimateCall(it, s, Number(it.page));
      if (m.priceInPerM === '' || m.priceOutPerM === '') { unknown = true; continue; }
      total += (tin * Number(m.priceInPerM) + tout * Number(m.priceOutPerM)) / 1e6;
    }
    return { total, unknown };
  }, [items, models, sizes]);

  const problems = [];
  if (!items.length) problems.push('选几张照片');
  if (items.some((it) => !it.page)) problems.push('每张照片标上原书第几页');
  if (!models.length) problems.push('至少选一个模型');
  if (!sizes.length) problems.push('至少选一种压缩尺寸');

  async function start() {
    setError('');
    const budget = cfg?.budget;
    const msg = `共 ${calls} 次识别（${items.length} 页 × ${models.length} 个模型 × ${sizes.length} 种尺寸），` +
      `预计${est.unknown ? (est.total ? `至少约 ${est.total.toFixed(2)} 元（有模型没填单价，那部分算不出）` : '花费未知（模型没填单价）') : `约 ${est.total.toFixed(2)} 元`}。` +
      (budget ? `\n本月已花 ${budget.spent} 元${budget.budget != null ? ` / 上限 ${budget.budget} 元` : ''}。` : '') +
      (budget?.over ? '\n⚠ 本月已经到上限了，继续会接着花。' : '') + '\n\n开始吗？';
    if (!confirm(msg)) return;
    let created;
    try {
      created = await post('/admin/ai/ocr-bench', {
        pages: items.map((it) => Number(it.page)),
        models: models.map((m) => ({ id: m.id, priceInPerM: m.priceInPerM === '' ? null : Number(m.priceInPerM), priceOutPerM: m.priceOutPerM === '' ? null : Number(m.priceOutPerM) })),
        sizes, estimateYuan: est.unknown ? null : Number(est.total.toFixed(4)), confirmOverBudget: Boolean(budget?.over),
      });
    } catch (e) { setError(e.message); return; }

    const results = [];
    setRun({ id: created.id, config: created.config, results });
    const tasks = [];
    for (const it of items) for (const s of sizes) tasks.push({ it, s });
    let done = 0;
    setProgress({ done, total: calls });
    // 一张图、一种尺寸压缩一次，再依次送给各个模型；两个任务同时跑
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const { it, s } = tasks[next++];
        let img;
        try { img = await compress(it.file, s); } catch (e) {
          for (const m of models) { results.push({ page: Number(it.page), model: m.id, size: s, error: `压缩失败：${e.message}` }); done++; }
          setProgress({ done, total: calls }); continue;
        }
        for (const m of models) {
          try {
            const r = await post(`/admin/ai/ocr-bench/${created.id}/recognize`, { page: Number(it.page), model: m.id, size: s, image: img.dataUrl });
            results.push({ id: r.resultId, ...r, imageW: img.w, imageH: img.h });
          } catch (e) {
            results.push({ page: Number(it.page), model: m.id, size: s, error: e.message });
          }
          done++;
          setProgress({ done, total: calls });
          setRun({ id: created.id, config: created.config, results: [...results] });
        }
        img = null;   // 压缩好的图不留
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

    // 全部回来后算指标（"字数偏少"要看同一模型、同一尺寸各页的中位数），存回服务端
    const scored = scoreAll(results);
    setRun({ id: created.id, config: created.config, results: scored });
    for (const r of scored) {
      if (r.id && r.metrics) await put(`/admin/ai/ocr-bench/${created.id}/results/${r.id}/metrics`, { metrics: r.metrics }).catch(() => {});
    }
    setProgress(null);
    loadPast();
  }

  async function openPast(id) {
    setError('');
    try {
      const r = await get(`/admin/ai/ocr-bench/${id}`);
      // 以前存过的指标直接用；没存上的（页面中途关了）现算
      setRun({ ...r, results: scoreAll(r.results, { keep: true }) });
      window.scrollTo(0, 0);
    } catch (e) { setError(e.message); }
  }

  if (error && !cfg) return <Alert>{error}</Alert>;
  if (!cfg) return <Loading />;

  return (
    <>
      <PageHead title="识别实测" desc="拿几页真实照片比几个读图模型：逐字和人工转写稿比，看谁准、谁快、谁便宜。照片只在识别那一刻用，不保存。" />
      <p className="small"><Link to="/admin/ai">← 返回 AI 配置</Link></p>
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {!cfg.provider ? <Alert>{cfg.modelsError}</Alert> : null}

      {!run || progress ? (
        <div className="card card-pad stack" style={{ marginBottom: 16 }} data-testid="bench-setup">
          <h2 style={{ fontSize: 15, margin: 0 }}>① 照片和页码</h2>
          <p className="tiny muted" style={{ margin: 0 }}>
            选公共英语资料的几页（建议：纯选择题、两栏选项、阅读篇章、教学重点、带手写答案的各一页）。标准答案是仓库里的人工转写稿。
          </p>
          <input ref={fileRef} type="file" accept="image/*" multiple className="input" data-testid="bench-files"
            disabled={Boolean(progress)} onChange={(e) => { addFiles([...(e.target.files || [])]); e.target.value = ''; }} />
          {items.map((it) => (
            <div key={it.key} className="row" style={{ gap: 8, flexWrap: 'wrap' }} data-testid="bench-item">
              <span className="small" style={{ flex: '1 1 140px', overflowWrap: 'anywhere' }}>{it.name}（{it.w}×{it.h}）</span>
              <select className="input" style={{ flex: '2 1 220px' }} value={it.page} disabled={Boolean(progress)}
                onChange={(e) => setItems((xs) => xs.map((x) => (x.key === it.key ? { ...x, page: e.target.value } : x)))}>
                <option value="">这是原书第几页？</option>
                {PAGE_OPTIONS.map((p) => <option key={p.page} value={p.page}>{p.label}</option>)}
              </select>
              <button className="btn ghost sm" disabled={Boolean(progress)} onClick={() => setItems((xs) => xs.filter((x) => x.key !== it.key))}>去掉</button>
            </div>
          ))}

          <h2 style={{ fontSize: 15, margin: '8px 0 0' }}>② 要比的模型</h2>
          <p className="tiny muted" style={{ margin: 0 }}>
            用「图片解析 AI」那一档的接口地址和 Key（{cfg.provider?.host || '未配置'}），只换模型。单价按服务商价目表填（元 / 百万 tokens），免费填 0。
            {cfg.modelsError ? ` ${cfg.modelsError}` : ''}
          </p>
          <div className="choice-grid">
            {[...new Set([cfg.provider?.model, ...suggestions].filter(Boolean))].map((id) => (
              <label key={id} className={`choice${models.some((m) => m.id === id) ? ' picked' : ''}`}>
                <input type="checkbox" checked={models.some((m) => m.id === id)} disabled={Boolean(progress)} onChange={() => toggleModel(id)} />
                <span style={{ overflowWrap: 'anywhere' }}>{id}{id === cfg.provider?.model ? '（现在用的）' : ''}</span>
              </label>
            ))}
          </div>
          <div className="row" style={{ gap: 8 }}>
            <input className="input" style={{ flex: 1 }} placeholder="其他模型名，如 Qwen/Qwen2.5-VL-72B-Instruct" value={extra}
              onChange={(e) => setExtra(e.target.value)} data-testid="bench-extra-model" />
            <button className="btn ghost sm" disabled={!extra.trim() || Boolean(progress)}
              onClick={() => { if (!models.some((m) => m.id === extra.trim())) toggleModel(extra.trim()); setExtra(''); }}>添加</button>
          </div>
          {models.map((m) => (
            <div key={m.id} className="row" style={{ gap: 8, flexWrap: 'wrap' }} data-testid="bench-model">
              <span className="small" style={{ flex: '1 1 200px', overflowWrap: 'anywhere' }}>{m.id}</span>
              <input className="input" style={{ flex: '1 1 100px' }} inputMode="decimal" placeholder="输入单价" value={m.priceInPerM}
                disabled={Boolean(progress)} onChange={(e) => setPrice(m.id, 'priceInPerM', e.target.value)} />
              <input className="input" style={{ flex: '1 1 100px' }} inputMode="decimal" placeholder="输出单价" value={m.priceOutPerM}
                disabled={Boolean(progress)} onChange={(e) => setPrice(m.id, 'priceOutPerM', e.target.value)} />
            </div>
          ))}

          <h2 style={{ fontSize: 15, margin: '8px 0 0' }}>③ 压缩尺寸（长边像素）</h2>
          <div className="row" style={{ gap: 8 }}>
            {[1600, 2400].map((s) => (
              <label key={s} className={`choice${sizes.includes(s) ? ' picked' : ''}`} style={{ flex: 1 }}>
                <input type="checkbox" checked={sizes.includes(s)} disabled={Boolean(progress)}
                  onChange={() => setSizes((xs) => (xs.includes(s) ? xs.filter((x) => x !== s) : [...xs, s].sort()))} />
                <span>{s}</span>
              </label>
            ))}
          </div>

          <p className="small" data-testid="bench-estimate">
            共 <strong>{calls}</strong> 次识别；预计
            {est.unknown ? (est.total ? ` 至少约 ${est.total.toFixed(2)} 元（有模型没填单价）` : ' 花费未知（没填单价）') : ` 约 ${est.total.toFixed(2)} 元`}
            {cfg.budget ? `；本月已花 ${cfg.budget.spent} 元${cfg.budget.budget != null ? ` / 上限 ${cfg.budget.budget} 元` : ''}` : ''}
          </p>
          {problems.length && !progress ? <p className="small" style={{ color: 'var(--warn)', margin: 0 }}>还差：{problems.join('；')}</p> : null}
          {progress ? (
            <p className="small" data-testid="bench-progress">识别中：{progress.done} / {progress.total}（关掉页面会停，已识别的结果都存着）</p>
          ) : null}
          <div className="sticky-actions">
            <button className="btn" onClick={start} disabled={Boolean(progress) || problems.length > 0 || !cfg.provider} data-testid="bench-start">
              {progress ? '识别中…' : '开始实测'}
            </button>
          </div>
        </div>
      ) : null}

      {run && !progress ? <Report run={run} onNew={() => { setRun(null); setItems([]); }} /> : null}

      {past.length ? (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>以前的实测</h2>
          <div className="stack">
            {past.map((p) => (
              <button key={p.id} className="btn ghost sm" style={{ justifyContent: 'flex-start', width: '100%', minWidth: 0, whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere', height: 'auto' }} onClick={() => openPast(p.id)}>
                {formatBeijing(p.createdAt)} · {p.config.pages.length} 页 × {p.config.models.length} 个模型 × {p.config.sizes.length} 种尺寸 · {p.results} 次 · {yuan(p.cost)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

// 给一批结果算指标。keep = true 时已经存过指标的不重算
function scoreAll(results, { keep = false } = {}) {
  const groups = new Map();
  for (const r of results) {
    const k = `${r.model}|${r.size}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const rs of groups.values()) {
    // "字数偏少"的线：同一模型、同一尺寸各页识别字数的中位数的一半
    const firstPass = rs.map((r) => (r.text ? evaluate(r.text, r.page).chars : 0));
    const minChars = shortLine(firstPass);
    for (const r of rs) {
      if (keep && r.metrics) { out.push(r); continue; }
      out.push(r.text != null && !r.error ? { ...r, metrics: evaluate(r.text, r.page, { minChars }) } : r);
    }
  }
  return out;
}

function summarize(results) {
  const by = new Map();
  for (const r of results) {
    const k = `${r.model}|${r.size}`;
    if (!by.has(k)) by.set(k, { model: r.model, size: r.size, rs: [] });
    by.get(k).rs.push(r);
  }
  return [...by.values()].map(({ model, size, rs }) => {
    const ok = rs.filter((r) => r.metrics && r.metrics.accuracy != null);
    const acc = ok.length ? ok.reduce((n, r) => n + r.metrics.accuracy, 0) / ok.length : null;
    const minAcc = ok.length ? Math.min(...ok.map((r) => r.metrics.accuracy)) : null;
    const comp = rs.filter((r) => r.metrics?.completeness);
    const compOk = comp.reduce((n, r) => n + r.metrics.completeness.ok, 0);
    const compTotal = comp.reduce((n, r) => n + r.metrics.completeness.total, 0);
    const det = rs.filter((r) => r.metrics?.detection);
    const errLines = det.reduce((n, r) => n + r.metrics.detection.errLines, 0);
    const caught = det.reduce((n, r) => n + r.metrics.detection.caught, 0);
    const flagged = det.reduce((n, r) => n + r.metrics.detection.flagged, 0);
    const falsePos = det.reduce((n, r) => n + r.metrics.detection.falsePos, 0);
    const lat = rs.filter((r) => r.latencyMs);
    const costs = rs.map((r) => r.cost);
    return {
      model, size, pages: rs.length, failed: rs.filter((r) => r.error).length,
      accuracy: acc, minAccuracy: minAcc,
      completeness: compTotal ? compOk / compTotal : null, compOk, compTotal,
      detectRate: errLines ? caught / errLines : null, falsePosRate: flagged ? falsePos / flagged : null,
      latencyMs: lat.length ? lat.reduce((n, r) => n + r.latencyMs, 0) / lat.length : null,
      cost: costs.some((x) => x == null) ? null : costs.reduce((n, x) => n + x, 0),
      costPartial: costs.some((x) => x == null),
      pass: acc != null && acc >= THRESHOLD.accuracy && (compTotal === 0 || compOk === compTotal),
    };
  }).sort((a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1));
}

function toMarkdown(run, rows) {
  const L = [];
  L.push(`# 识别实测报告（${formatBeijing(run.createdAt || new Date().toISOString().slice(0, 19).replace('T', ' '))}）`, '');
  L.push(`页：${run.config.pages.join('、')}；模型：${run.config.models.map((m) => m.id).join('、')}；尺寸：${run.config.sizes.join('、')}`, '');
  L.push('| 模型 | 尺寸 | 平均字符准确率 | 最低一页 | 题目完整率 | 体检检出率 | 误报率 | 平均耗时 | 花费 | 达到门槛 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    L.push(`| ${r.model} | ${r.size} | ${pct(r.accuracy)} | ${pct(r.minAccuracy)} | ${r.compTotal ? `${r.compOk}/${r.compTotal}` : '—'} | ` +
      `${pct(r.detectRate)} | ${pct(r.falsePosRate)} | ${r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)} 秒` : '—'} | ` +
      `${r.cost == null ? '缺单价' : `${r.cost.toFixed(4)} 元`} | ${r.pass ? '是' : '否'} |`);
  }
  L.push('', '门槛：字符准确率 ≥ 99.5%、题目完整率 100%（BRD 第 0 节）。教学重点、样卷页是整课 / 整卷比对，转写稿不含栏目标题，准确率略偏低。', '');
  L.push('## 每页明细', '');
  for (const r of [...run.results].sort((a, b) => a.page - b.page || a.model.localeCompare(b.model) || a.size - b.size)) {
    const m = r.metrics;
    L.push(`- 第 ${r.page} 页 · ${r.model} · ${r.size}：` + (r.error ? `失败（${r.error}）` :
      `准确率 ${pct(m?.accuracy)}${m?.completeness ? `，完整 ${m.completeness.ok}/${m.completeness.total}${m.completeness.missing.length ? `（缺第 ${m.completeness.missing.join('、')} 题）` : ''}` : ''}` +
      `，体检标了 ${m?.flags?.length ?? 0} 处，耗时 ${r.latencyMs ? (r.latencyMs / 1000).toFixed(1) : '—'} 秒`));
    for (const e of m?.errorSamples || []) L.push(`  - 第 ${e.line} 行${e.flagged ? '（体检标出）' : '（体检漏了）'}：${e.text}`);
  }
  return L.join('\n');
}

function Report({ run, onNew }) {
  const rows = summarize(run.results);
  const [open, setOpen] = useState(null);
  const download = () => {
    const blob = new Blob([toMarkdown(run, rows)], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `识别实测-${(run.id || '').slice(-8)}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  return (
    <div className="card card-pad" data-testid="bench-report">
      <div className="spread" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>实测报告</h2>
        <span className="row" style={{ gap: 6 }}>
          <button className="btn ghost sm" onClick={download} data-testid="bench-export">导出报告（.md）</button>
          <button className="btn ghost sm" onClick={onNew}>再测一次</button>
        </span>
      </div>
      <p className="tiny muted">门槛：字符准确率 ≥ 99.5%、题目完整率 100%。按平均准确率从高到低排。</p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table responsive">
          <thead><tr><th>模型</th><th>尺寸</th><th>准确率</th><th>最低一页</th><th>完整率</th><th>体检检出</th><th>误报</th><th>耗时</th><th>花费</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.model}|${r.size}`} data-testid="bench-row">
                <td data-label="模型" style={{ overflowWrap: 'anywhere' }}>{r.model}{r.failed ? <span className="badge danger" style={{ marginLeft: 6 }}>失败 {r.failed}</span> : null}</td>
                <td data-label="尺寸">{r.size}</td>
                <td data-label="准确率" data-testid="bench-acc">{pct(r.accuracy)}</td>
                <td data-label="最低一页">{pct(r.minAccuracy)}</td>
                <td data-label="完整率">{r.compTotal ? `${r.compOk}/${r.compTotal}` : '—'}</td>
                <td data-label="体检检出">{pct(r.detectRate)}</td>
                <td data-label="误报">{pct(r.falsePosRate)}</td>
                <td data-label="耗时">{r.latencyMs ? `${(r.latencyMs / 1000).toFixed(1)} 秒` : '—'}</td>
                <td data-label="花费">{r.cost == null ? '缺单价' : yuan(r.cost)}</td>
                <td data-label="">{r.pass ? <span className="badge ok">达到门槛</span> : <span className="badge gray">没达到</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3 style={{ fontSize: 14, margin: '12px 0 6px' }}>每页明细</h3>
      <div className="stack">
        {run.results.map((r, i) => (
          <div key={r.id || i} className="small">
            <button className="btn ghost sm" style={{ justifyContent: 'flex-start', width: '100%', minWidth: 0, whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere', height: 'auto' }} onClick={() => setOpen(open === i ? null : i)}>
              第 {r.page} 页 · {r.model} · {r.size}：{r.error ? `失败（${r.error}）` : `准确率 ${pct(r.metrics?.accuracy)}`}
              {r.metrics?.completeness ? ` · 完整 ${r.metrics.completeness.ok}/${r.metrics.completeness.total}` : ''}
              {r.metrics?.flags?.length ? ` · 体检标了 ${r.metrics.flags.length} 处` : ''}
            </button>
            {open === i && r.metrics ? (
              <div className="passage" style={{ marginTop: 6 }}>
                {r.metrics.unavailable ? <p className="tiny muted">{r.metrics.unavailable}</p> : null}
                {r.metrics.completeness?.missing?.length ? <p className="tiny">缺的题（或选项不齐）：第 {r.metrics.completeness.missing.join('、')} 题</p> : null}
                {(r.metrics.errorSamples || []).map((e) => (
                  <div key={e.line} className="tiny" style={{ overflowWrap: 'anywhere' }}>
                    <span className={`badge ${e.flagged ? 'ok' : 'warn'}`} style={{ marginRight: 6 }}>{e.flagged ? '体检标出' : '体检漏了'}</span>
                    第 {e.line} 行：{e.text}
                  </div>
                ))}
                {[...new Map((r.metrics.flags || []).map((f) => [`${f.rule}|${f.message}`, f])).values()].map((f) => (
                  <div key={`${f.rule}|${f.message}`} className="tiny muted">体检：{f.message}</div>
                ))}
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
