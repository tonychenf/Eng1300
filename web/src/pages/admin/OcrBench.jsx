import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post, put } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';
import { formatBeijing } from '../../lib/time.js';
// 比对算法和转写稿放在 worker 那边（第三期导入时服务端也要用），页面直接引同一份
import { evaluateRef, matchReference, referenceForPage, shortLine } from '../../../../worker/src/ocr-bench/evaluate.js';
import { agreement, normalizeText } from '../../../../worker/src/lib/ocr-metrics.js';

// 识别实测（改进阶段 2 第二期，PRD 第 6 节）。什么照片都能测，不用标页码（用户 2026-11-10）：
//   ① 选几张照片（任何学科、任何资料）；选要比的模型（带单价）和压缩尺寸；
//   ② 先看预估：几次识别、大概多少钱 → 点"开始"；
//   ③ 浏览器压缩图片、一张张送去识别（图只在那一次请求里，服务端不留）；
//   ④ 识别出的文字自己去仓库的人工转写稿里找对得上的页：对上了逐字算准确率；对不上就把原图和各模型的结果并排放，
//      几个模型说法不一样的行标黄，人对着原图看；
//   ⑤ 出报告：每个模型 × 尺寸的准确率、题目完整率、和别的模型一致的比例、体检、耗时、花费，可导出。

const THRESHOLD = { accuracy: 0.995, completeness: 1 };   // BRD 第 0 节的上线门槛
const LIKELY_VISION = /(vl|ocr|vision|omni|qvq|internvl|janus|glm-4(\.\d)?v|pixtral|llava|gemma-3)/i;
const CONCURRENCY = 2;
const MAX_PHOTOS = 10;   // 服务端一次实测也是最多 10 张
const pct = (x) => (x == null ? '—' : `${(x * 100).toFixed(2)}%`);
const yuan = (x) => (x == null ? '—' : `${Number(x).toFixed(4)} 元`);
const sec = (ms) => (ms ? `${(ms / 1000).toFixed(1)} 秒` : '—');

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

// 预估：输入 ≈ 图片 tokens（按 28×28 一块估）+ 提示词；输出按一页 1500 tokens 估
function estimateCall({ w, h }, size) {
  const s = Math.min(1, size / Math.max(w, h));
  return { tin: Math.ceil((w * s) / 28) * Math.ceil((h * s) / 28) + 150, tout: 1500 };
}

// 一个结果属于哪张照片。2026-11-09 那一版是标页码的（只有 page），之后是第几张照片（photo）
const photoKey = (r) => (r.photo != null ? `photo-${r.photo}` : `page-${r.page}`);
function photosOf(run) {
  if (run.config.photos) return run.config.photos.map((p) => ({ key: `photo-${p.no}`, no: p.no, name: p.name }));
  return (run.config.pages || []).map((pg, i) => ({ key: `page-${pg}`, no: i + 1, name: `原书第 ${pg} 页（标过页码）`, page: pg }));
}

export default function OcrBench() {
  const [cfg, setCfg] = useState(null);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);       // [{ key, file, name, w, h, url }]
  const [models, setModels] = useState([]);     // [{ id, priceInPerM, priceOutPerM }]
  const [extra, setExtra] = useState('');
  const [sizes, setSizes] = useState([1600, 2400]);
  const [run, setRun] = useState(null);         // { id, config, results, images }
  const [progress, setProgress] = useState(null);
  const [past, setPast] = useState([]);
  const [dragging, setDragging] = useState(false);
  const itemsRef = useRef([]);
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

  // 一次选多张、分几次加、拖进来的都走这里；每次都是往后加，不替换已经选的
  async function addFiles(list) {
    const files = [...list];
    if (!files.length) return;
    const notImage = files.filter((f) => !(f.type || '').startsWith('image/') && !/\.(jpe?g|png|webp|heic|heif|bmp|gif)$/i.test(f.name));
    const next = [];
    const unreadable = [];
    for (const f of files.filter((x) => !notImage.includes(x))) {
      try {
        const d = await dims(f);
        // 预览用的本地地址：只在这个页面里、这一次打开时有，不上传、不保存
        next.push({ key: `${f.name}-${f.size}-${Math.random()}`, file: f, name: f.name, url: URL.createObjectURL(f), ...d });
      } catch {
        unreadable.push(f.name);
      }
    }
    // 已经选了几张按 ref 算（连着加几次时，状态还没来得及更新）
    const room = Math.max(0, MAX_PHOTOS - itemsRef.current.length);
    const kept = next.slice(0, room);
    next.slice(room).forEach((x) => URL.revokeObjectURL(x.url));
    itemsRef.current = [...itemsRef.current, ...kept];
    setItems(itemsRef.current);
    const msgs = [];
    if (notImage.length) msgs.push(`「${notImage.map((f) => f.name).join('」「')}」不是图片，没加`);
    if (unreadable.length) msgs.push(`「${unreadable.join('」「')}」读不出来（HEIC 照片请在相册里存成 JPEG 再选）`);
    if (next.length > room) msgs.push(`一次实测最多 ${MAX_PHOTOS} 张，多出来的 ${next.length - room} 张没加`);
    setError(msgs.join('；'));
  }
  const removeItem = (key) => {
    itemsRef.current = itemsRef.current.filter((x) => {
      if (x.key === key) URL.revokeObjectURL(x.url);
      return x.key !== key;
    });
    setItems(itemsRef.current);
  };

  const calls = items.length * models.length * sizes.length;
  const est = useMemo(() => {
    let total = 0;
    let unknown = false;
    for (const it of items) for (const s of sizes) for (const m of models) {
      const { tin, tout } = estimateCall(it, s);
      if (m.priceInPerM === '' || m.priceOutPerM === '') { unknown = true; continue; }
      total += (tin * Number(m.priceInPerM) + tout * Number(m.priceOutPerM)) / 1e6;
    }
    return { total, unknown };
  }, [items, models, sizes]);

  const problems = [];
  if (!items.length) problems.push('选几张照片');
  if (!models.length) problems.push('至少选一个模型');
  if (!sizes.length) problems.push('至少选一种压缩尺寸');

  async function start() {
    setError('');
    const budget = cfg?.budget;
    const msg = `共 ${calls} 次识别（${items.length} 张 × ${models.length} 个模型 × ${sizes.length} 种尺寸），` +
      `预计${est.unknown ? (est.total ? `至少约 ${est.total.toFixed(2)} 元（有模型没填单价，那部分算不出）` : '花费未知（模型没填单价）') : `约 ${est.total.toFixed(2)} 元`}。` +
      (budget ? `\n本月已花 ${budget.spent} 元${budget.budget != null ? ` / 上限 ${budget.budget} 元` : ''}。` : '') +
      (budget?.over ? '\n⚠ 本月已经到上限了，继续会接着花。' : '') + '\n\n开始吗？';
    if (!confirm(msg)) return;
    let created;
    try {
      created = await post('/admin/ai/ocr-bench', {
        photos: items.map((it) => ({ name: it.name })),
        models: models.map((m) => ({ id: m.id, priceInPerM: m.priceInPerM === '' ? null : Number(m.priceInPerM), priceOutPerM: m.priceOutPerM === '' ? null : Number(m.priceOutPerM) })),
        sizes, estimateYuan: est.unknown ? null : Number(est.total.toFixed(4)), confirmOverBudget: Boolean(budget?.over),
      });
    } catch (e) { setError(e.message); return; }

    // 第几张照片 → 预览地址（报告里和识别结果并排放）
    const images = Object.fromEntries(items.map((it, i) => [`photo-${i + 1}`, it.url]));
    const results = [];
    const show = (rs) => setRun({ id: created.id, config: created.config, results: rs, images });
    show(results);
    const tasks = [];
    items.forEach((it, i) => { for (const s of sizes) tasks.push({ it, no: i + 1, s }); });
    let done = 0;
    setProgress({ done, total: calls });
    // 一张图、一种尺寸压缩一次，再依次送给各个模型；两个任务同时跑
    let next = 0;
    const worker = async () => {
      while (next < tasks.length) {
        const { it, no, s } = tasks[next++];
        let img;
        try { img = await compress(it.file, s); } catch (e) {
          for (const m of models) { results.push({ photo: no, model: m.id, size: s, error: `压缩失败：${e.message}` }); done++; }
          setProgress({ done, total: calls }); continue;
        }
        for (const m of models) {
          try {
            const r = await post(`/admin/ai/ocr-bench/${created.id}/recognize`, { photo: no, model: m.id, size: s, image: img.dataUrl });
            results.push({ id: r.resultId, ...r, imageW: img.w, imageH: img.h });
          } catch (e) {
            results.push({ photo: no, model: m.id, size: s, error: e.message });
          }
          done++;
          setProgress({ done, total: calls });
          show([...results]);
        }
        img = null;   // 压缩好的图不留
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

    // 全部回来后算指标（找转写稿、模型之间比、"字数偏少"看同一模型同一尺寸各张的中位数），存回服务端
    setProgress({ done, total: calls, scoring: true });
    await new Promise((r) => setTimeout(r, 30));   // 先把"正在比对"画出来
    const scored = scoreAll(results);
    show(scored);
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
      // 以前存过的指标直接用；没存上的（页面中途关了）现算。原图没保存，只有文字
      setRun({ ...r, results: scoreAll(r.results, { keep: true }), images: {} });
      window.scrollTo(0, 0);
    } catch (e) { setError(e.message); }
  }

  if (error && !cfg) return <Alert>{error}</Alert>;
  if (!cfg) return <Loading />;

  return (
    <>
      <PageHead title="识别实测" desc="拿几张真实照片比几个读图模型，看谁认得准、谁快、谁便宜。什么学科、什么资料的照片都行，不用标页码。照片只在识别那一刻用，不保存。" />
      <p className="small"><Link to="/admin/ai">← 返回 AI 配置</Link></p>
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {!cfg.provider ? <Alert>{cfg.modelsError}</Alert> : null}

      {!run || progress ? (
        <div className="card card-pad stack" style={{ marginBottom: 16 }} data-testid="bench-setup">
          <h2 style={{ fontSize: 15, margin: 0 }}>① 照片</h2>
          <p className="tiny muted" style={{ margin: 0 }}>
            最多 10 张，任何学科、任何资料都行。识别完会自动去仓库的人工转写稿里找这一页：找到了（现在有公共英语的 38 页）就逐字算准确率；
            找不到就把原图和各模型认出来的字并排放，几个模型说法不一样的行标出来，你对着原图看。
          </p>
          {/* 一次可以多选；有的手机浏览器（比如微信里打开）一次只让选一张，就再点一次接着加。电脑上可以直接拖进来 */}
          <div className={`bench-drop${dragging ? ' over' : ''}`} data-testid="bench-drop"
            onDragOver={(e) => { e.preventDefault(); if (!progress) setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); if (!progress) addFiles(e.dataTransfer?.files || []); }}>
            <label className={`btn${items.length ? ' ghost' : ''}${progress || items.length >= MAX_PHOTOS ? ' disabled' : ''}`} data-testid="bench-pick">
              {items.length ? '继续添加照片' : '选照片（可以一次选多张）'}
              <input ref={fileRef} type="file" accept="image/*" multiple className="visually-hidden" data-testid="bench-files"
                disabled={Boolean(progress) || items.length >= MAX_PHOTOS}
                onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; addFiles(fs); }} />
            </label>
            <span className="tiny muted" data-testid="bench-count">
              已选 {items.length} / {MAX_PHOTOS} 张。手机相册一次只让选一张的（比如在微信里打开），选完再点一次接着加；电脑上也可以把照片直接拖进这个框。
            </span>
          </div>
          {items.length ? (
            <div className="bench-thumbs">
              {items.map((it, i) => (
                <div key={it.key} className="bench-thumb" data-testid="bench-item">
                  <img src={it.url} alt={`照片 ${i + 1}`} />
                  <span className="tiny" style={{ overflowWrap: 'anywhere' }}>{i + 1}. {it.name}（{it.w}×{it.h}）</span>
                  <button className="btn ghost sm" disabled={Boolean(progress)} onClick={() => removeItem(it.key)}>去掉</button>
                </div>
              ))}
            </div>
          ) : null}

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
            <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="其他模型名，如 Qwen/Qwen2.5-VL-72B-Instruct" value={extra}
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
              <button className="btn ghost sm" disabled={Boolean(progress)} onClick={() => toggleModel(m.id)}>去掉</button>
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
            <p className="small" data-testid="bench-progress">
              {progress.scoring ? '都识别完了，正在比对…' : `识别中：${progress.done} / ${progress.total}（关掉页面会停，已识别的结果都存着）`}
            </p>
          ) : null}
          <div className="sticky-actions">
            <button className="btn" onClick={start} disabled={Boolean(progress) || problems.length > 0 || !cfg.provider} data-testid="bench-start">
              {progress ? '识别中…' : '开始实测'}
            </button>
          </div>
        </div>
      ) : null}

      {run && !progress ? <Report run={run} onNew={() => { setRun(null); items.forEach((it) => URL.revokeObjectURL(it.url)); itemsRef.current = []; setItems([]); }} /> : null}

      {past.length ? (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>以前的实测</h2>
          <div className="stack">
            {past.map((p) => (
              <button key={p.id} className="btn ghost sm" style={{ justifyContent: 'flex-start', width: '100%', minWidth: 0, whiteSpace: 'normal', textAlign: 'left', overflowWrap: 'anywhere', height: 'auto' }} onClick={() => openPast(p.id)}>
                {formatBeijing(p.createdAt)} · {(p.config.photos || p.config.pages || []).length} 张 × {p.config.models.length} 个模型 × {p.config.sizes.length} 种尺寸 · {p.results} 次 · {yuan(p.cost)}
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

// 给一批结果算指标。keep = true 时已经存过指标的不重算（模型之间的一致总是现算，很快）
function scoreAll(results, { keep = false } = {}) {
  const ok = (r) => r.text != null && !r.error;
  const byPhoto = new Map();
  for (const r of results) {
    const k = photoKey(r);
    if (!byPhoto.has(k)) byPhoto.set(k, []);
    byPhoto.get(k).push(r);
  }
  // 每张照片一份参照：以前标了页码的按页码；否则拿各模型的结果去转写稿里找，取对得最好的那一个——
  // 同一张照片各模型都对同一份参照算，认得差的模型不会因为"没对上"而逃过准确率
  const refOf = new Map();
  for (const [k, rs] of byPhoto) {
    if (rs[0].photo == null) { refOf.set(k, referenceForPage(rs[0].page)); continue; }
    let best = null;
    for (const r of rs.filter(ok)) {
      const m = matchReference(r.text);
      if (m && (!best || m.accuracy > best.accuracy)) best = m;
      if (best && best.accuracy > 0.95) break;
    }
    refOf.set(k, best ? best.ref : null);
  }
  // "字数偏少"的线：同一模型、同一尺寸各张识别字数的中位数的一半
  const counts = new Map();
  for (const r of results.filter(ok)) {
    const k = `${r.model}|${r.size}`;
    if (!counts.has(k)) counts.set(k, []);
    counts.get(k).push(normalizeText(r.text).s.length);
  }
  // 同一张照片、同一尺寸，几个模型之间比
  const agree = new Map();
  for (const rs of byPhoto.values()) {
    for (const size of new Set(rs.map((r) => r.size))) {
      const same = rs.filter((r) => r.size === size && ok(r));
      agreement(same.map((r) => r.text)).forEach((a, i) => agree.set(same[i], a));
    }
  }
  return results.map((r) => {
    if (!ok(r)) return r;
    const a = agree.get(r);
    const ag = a && a.rate != null ? { rate: a.rate, lines: a.lines } : null;
    if (keep && r.metrics) return { ...r, metrics: { ...r.metrics, agree: ag } };
    const m = evaluateRef(r.text, refOf.get(photoKey(r)), { minChars: shortLine(counts.get(`${r.model}|${r.size}`) || []) });
    return { ...r, metrics: { ...m, agree: ag } };
  });
}

function summarize(results) {
  const by = new Map();
  for (const r of results) {
    const k = `${r.model}|${r.size}`;
    if (!by.has(k)) by.set(k, { model: r.model, size: r.size, rs: [] });
    by.get(k).rs.push(r);
  }
  const avg = (xs) => (xs.length ? xs.reduce((n, x) => n + x, 0) / xs.length : null);
  return [...by.values()].map(({ model, size, rs }) => {
    const matched = rs.filter((r) => r.metrics && r.metrics.accuracy != null);
    const acc = avg(matched.map((r) => r.metrics.accuracy));
    const comp = rs.filter((r) => r.metrics?.completeness);
    const compOk = comp.reduce((n, r) => n + r.metrics.completeness.ok, 0);
    const compTotal = comp.reduce((n, r) => n + r.metrics.completeness.total, 0);
    const det = rs.filter((r) => r.metrics?.detection);
    const errLines = det.reduce((n, r) => n + r.metrics.detection.errLines, 0);
    const caught = det.reduce((n, r) => n + r.metrics.detection.caught, 0);
    const flagged = det.reduce((n, r) => n + r.metrics.detection.flagged, 0);
    const falsePos = det.reduce((n, r) => n + r.metrics.detection.falsePos, 0);
    const costs = rs.map((r) => r.cost);
    return {
      model, size, photos: rs.length, failed: rs.filter((r) => r.error).length, matched: matched.length,
      accuracy: acc, minAccuracy: matched.length ? Math.min(...matched.map((r) => r.metrics.accuracy)) : null,
      compOk, compTotal,
      agree: avg(rs.filter((r) => r.metrics?.agree).map((r) => r.metrics.agree.rate)),
      flags: rs.reduce((n, r) => n + (r.metrics?.flags?.length || 0), 0),
      detectRate: errLines ? caught / errLines : null, falsePosRate: flagged ? falsePos / flagged : null,
      latencyMs: avg(rs.filter((r) => r.latencyMs).map((r) => r.latencyMs)),
      cost: costs.some((x) => x == null) ? null : costs.reduce((n, x) => n + x, 0),
      pass: acc != null && acc >= THRESHOLD.accuracy && (compTotal === 0 || compOk === compTotal),
    };
  }).sort((a, b) => (b.accuracy ?? -1) - (a.accuracy ?? -1) || (b.agree ?? -1) - (a.agree ?? -1));
}

const linesOf = (text) => String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
const matchText = (ref) => (ref ? `对上转写稿：${ref.label}` : '转写稿里没有这一页，对着原图看');

function toMarkdown(run, rows) {
  const L = [];
  const photos = photosOf(run);
  L.push(`# 识别实测报告（${formatBeijing(run.createdAt || new Date().toISOString().slice(0, 19).replace('T', ' '))}）`, '');
  L.push(`照片 ${photos.length} 张；模型：${run.config.models.map((m) => m.id).join('、')}；尺寸：${run.config.sizes.join('、')}`, '');
  L.push('| 模型 | 尺寸 | 字符准确率（对上转写稿的） | 最低一张 | 题目完整率 | 和别的模型一致 | 体检标出 | 检出率 | 误报率 | 平均耗时 | 花费 | 达到门槛 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    L.push(`| ${r.model} | ${r.size} | ${r.matched ? `${pct(r.accuracy)}（${r.matched} 张）` : '—'} | ${pct(r.minAccuracy)} | ${r.compTotal ? `${r.compOk}/${r.compTotal}` : '—'} | ` +
      `${pct(r.agree)} | ${r.flags} 处 | ${pct(r.detectRate)} | ${pct(r.falsePosRate)} | ${sec(r.latencyMs)} | ` +
      `${r.cost == null ? '缺单价' : `${r.cost.toFixed(4)} 元`} | ${r.matched ? (r.pass ? '是' : '否') : '没法判'} |`);
  }
  L.push('', '门槛：字符准确率 ≥ 99.5%、题目完整率 100%（BRD 第 0 节），只有对上转写稿的照片能算。「和别的模型一致」是同一张照片、同一尺寸下几个模型认出的字互相对得上的比例：几个模型都一样不保证对，但不一样的地方一定有人错了。', '');
  L.push('## 每张照片', '');
  for (const ph of photos) {
    const rs = run.results.filter((r) => photoKey(r) === ph.key).sort((a, b) => a.model.localeCompare(b.model) || a.size - b.size);
    const ref = rs.find((r) => r.metrics)?.metrics?.ref;
    L.push(`### 照片 ${ph.no} · ${ph.name}`, '', matchText(ref), '');
    for (const r of rs) {
      const m = r.metrics;
      L.push(`- **${r.model} · ${r.size}**：` + (r.error ? `失败（${r.error}）` :
        `${m?.accuracy != null ? `准确率 ${pct(m.accuracy)}，` : ''}${m?.completeness ? `完整 ${m.completeness.ok}/${m.completeness.total}${m.completeness.missing.length ? `（缺第 ${m.completeness.missing.join('、')} 题）` : ''}，` : ''}` +
        `${m?.agree ? `和别的模型一致 ${pct(m.agree.rate)}，` : ''}体检标了 ${m?.flags?.length ?? 0} 处，耗时 ${sec(r.latencyMs)}`));
      for (const e of m?.errorSamples || []) L.push(`  - 第 ${e.line} 行${e.flagged ? '（体检标出）' : '（体检漏了）'}：${e.text}`);
      // 认出来的全文每一份都附上（用户 2026-11-10：识别完要把文字给我看）
      if (r.text) L.push('', '```text', r.text, '```', '');
    }
    L.push('');
  }
  return L.join('\n');
}

function Report({ run, onNew }) {
  const rows = summarize(run.results);
  const photos = photosOf(run);
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
      <p className="tiny muted">
        准确率只有对上转写稿的照片才算（门槛 ≥ 99.5%、题目完整率 100%）。「和别的模型一致」：同一张照片几个模型认出的字互相对得上的比例——
        都一样不保证对，但不一样的地方一定有人错了，下面每张照片里标黄的就是这些地方。
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table className="table responsive">
          <thead><tr><th>模型</th><th>尺寸</th><th>准确率</th><th>最低一张</th><th>完整率</th><th>和别的模型一致</th><th>体检标出</th><th>耗时</th><th>花费</th><th></th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.model}|${r.size}`} data-testid="bench-row">
                <td data-label="模型" style={{ overflowWrap: 'anywhere' }}>{r.model}{r.failed ? <span className="badge danger" style={{ marginLeft: 6 }}>失败 {r.failed}</span> : null}</td>
                <td data-label="尺寸">{r.size}</td>
                <td data-label="准确率" data-testid="bench-acc">{r.matched ? pct(r.accuracy) : '—'}</td>
                <td data-label="最低一张">{pct(r.minAccuracy)}</td>
                <td data-label="完整率">{r.compTotal ? `${r.compOk}/${r.compTotal}` : '—'}</td>
                <td data-label="和别的模型一致" data-testid="bench-agree">{pct(r.agree)}</td>
                <td data-label="体检标出">{r.flags} 处</td>
                <td data-label="耗时">{sec(r.latencyMs)}</td>
                <td data-label="花费">{r.cost == null ? '缺单价' : yuan(r.cost)}</td>
                <td data-label="">{!r.matched ? <span className="badge gray">没有转写稿可比</span> : r.pass ? <span className="badge ok">达到门槛</span> : <span className="badge gray">没达到</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3 style={{ fontSize: 15, margin: '16px 0 6px' }}>每张照片：原图和各模型认出的字</h3>
      <p className="tiny muted" style={{ margin: '0 0 8px' }}>
        <span className="bench-mark err">红</span> 和转写稿不一样　<span className="bench-mark dis">黄</span> 几个模型说法不一样　<span className="bench-flag">⚑</span> 体检标出
      </p>
      <div className="stack">
        {photos.map((ph) => <PhotoPanel key={ph.key} photo={ph} url={run.images?.[ph.key]} results={run.results.filter((r) => photoKey(r) === ph.key)} />)}
      </div>
    </div>
  );
}

function PhotoPanel({ photo, url, results }) {
  const rs = [...results].sort((a, b) => a.model.localeCompare(b.model) || a.size - b.size);
  const ref = rs.find((r) => r.metrics)?.metrics?.ref ?? null;
  const [open, setOpen] = useState(0);
  const cur = rs[open];
  return (
    <div className="bench-photo" data-testid="bench-photo">
      <div className="small" style={{ fontWeight: 600, overflowWrap: 'anywhere' }}>照片 {photo.no} · {photo.name}</div>
      <div className="tiny" data-testid="bench-match" style={{ color: ref ? 'var(--ok)' : 'var(--warn)', marginBottom: 6 }}>{matchText(ref)}</div>
      <div className="bench-side">
        <div className="bench-img">
          {url ? <a href={url} target="_blank" rel="noreferrer"><img src={url} alt={`照片 ${photo.no} 原图`} data-testid="bench-photo-img" /></a>
            : <p className="tiny muted">原图没保存（识别完就丢了），只看得到文字</p>}
        </div>
        <div className="bench-texts">
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
            {rs.map((r, i) => (
              <button key={`${r.model}|${r.size}`} className={`btn sm ${i === open ? '' : 'ghost'}`} data-testid="bench-tab"
                style={{ whiteSpace: 'normal', height: 'auto', overflowWrap: 'anywhere', textAlign: 'left', minWidth: 0 }} onClick={() => setOpen(i)}>
                {r.model} · {r.size}
                {r.error ? '：失败' : r.metrics?.accuracy != null ? `：${pct(r.metrics.accuracy)}` : r.metrics?.agree ? `：一致 ${pct(r.metrics.agree.rate)}` : ''}
              </button>
            ))}
          </div>
          {cur ? <ResultText key={`${cur.model}|${cur.size}`} r={cur} /> : null}
        </div>
      </div>
    </div>
  );
}

function ResultText({ r }) {
  const [copied, setCopied] = useState('');
  if (r.error) return <p className="small" style={{ color: 'var(--danger)', overflowWrap: 'anywhere' }}>识别失败：{r.error}</p>;
  const copy = async () => {
    try { await navigator.clipboard.writeText(r.text || ''); setCopied('已复制'); }
    catch { setCopied('复制不了：请长按下面的文字手动选'); }
  };
  const m = r.metrics || {};
  const err = new Set(m.errLines || []);
  const dis = new Set(m.agree?.lines || []);
  const flags = new Map();
  for (const f of m.flags || []) if (!flags.has(f.line)) flags.set(f.line, f.message);
  return (
    <>
      <p className="tiny muted" style={{ margin: '0 0 4px' }}>
        {m.accuracy != null ? `准确率 ${pct(m.accuracy)}` : '没有转写稿可比'}
        {m.completeness ? ` · 完整 ${m.completeness.ok}/${m.completeness.total}${m.completeness.missing.length ? `（缺第 ${m.completeness.missing.join('、')} 题）` : ''}` : ''}
        {m.agree ? ` · 和别的模型一致 ${pct(m.agree.rate)}` : ''} · 体检 {m.flags?.length ?? 0} 处 · 耗时 {sec(r.latencyMs)}
      </p>
      <div className="row" style={{ gap: 8, alignItems: 'center', margin: '0 0 4px' }}>
        <strong className="small">识别出来的文字</strong>
        <button className="btn ghost sm" onClick={copy} data-testid="bench-copy">复制文字</button>
        {copied ? <span className="tiny muted" data-testid="bench-copied">{copied}</span> : null}
      </div>
      <div className="bench-text" data-testid="bench-text">
        {linesOf(r.text).map((ln, i) => (
          <div key={i} className={`bench-line${err.has(i) ? ' err' : dis.has(i) ? ' dis' : ''}`}
            data-mark={err.has(i) ? 'err' : dis.has(i) ? 'dis' : ''} title={flags.get(i) || undefined}>
            {flags.has(i) ? <span className="bench-flag">⚑</span> : null}{ln || ' '}
          </div>
        ))}
      </div>
    </>
  );
}
