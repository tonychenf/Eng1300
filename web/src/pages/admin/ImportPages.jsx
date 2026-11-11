import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, get, patch, post, put } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';
import { formatBeijing } from '../../lib/time.js';
import { assessFile, prepareUpload } from '../../lib/photo-qc.js';

// AI 拆题导入（改进阶段 2 第三期，PRD 7.1）。三个页面：
//   /admin/import/new        选学科、传照片（当场质检：拍坏的不让传）、预估确认、开始
//   /admin/import/:jobId     进度（后台排队识别，关了页面也继续）；识别完就是逐页核对
// 照片在浏览器里压成 JPEG（长边 2400，用户 2026-11-10 定），一张张传进任务；服务端只在排队那几分钟暂存，识别完就删。

const MAX_PAGES = 50;        // 一次最多 50 页（用户 2026-11-10 定）
const UPLOAD_LONG = 2400;    // 压缩尺寸（用户 2026-11-10 定）
const BUSY = ['待识别', '识别中', '拆题中'];
const yuan = (x) => (x == null ? '—' : `${Number(x).toFixed(2)} 元`);
const QC_BADGE = { ok: ['ok', '清楚'], yellow: ['warn', '注意'], red: ['danger', '要重拍'] };

// 预估：每页输入 ≈ 图片 tokens（按 28×28 一块估）+ 提示词，输出 ≈ 1500；拆题另算（单价看「文字解析 AI」）
function estimate(items, price) {
  if (!price || price.priceInPerM == null || price.priceOutPerM == null) return null;
  let total = 0;
  for (const it of items) {
    const s = Math.min(1, UPLOAD_LONG / Math.max(it.w || 1, it.h || 1));
    const tin = Math.ceil(((it.w || 1000) * s) / 28) * Math.ceil(((it.h || 1400) * s) / 28) + 300;
    total += (tin * Number(price.priceInPerM) + 1500 * Number(price.priceOutPerM)) / 1e6;
  }
  return total;
}

export function ImportNew() {
  const [sp] = useSearchParams();
  const nav = useNavigate();
  const [subjects, setSubjects] = useState(null);
  const [cfg, setCfg] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [subjectCode, setSubjectCode] = useState(sp.get('subject') || '');
  const [title, setTitle] = useState('');
  const [items, setItems] = useState([]);   // [{ key, file, name, url, w, h, qc: { level, problems } | null }]
  const itemsRef = useRef([]);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    get('/admin/subjects').then((r) => {
      const list = (r.subjects || []).filter((s) => s.status === '启用');
      setSubjects(list);
      if (!sp.get('subject') && list.length === 1) setSubjectCode(list[0].code);
    }).catch((e) => setError(e.message));
    get('/admin/ai/ocr-bench/config').then(setCfg).catch(() => setCfg({}));
    get('/admin/import/jobs').then((r) => setJobs(r.jobs || [])).catch(() => {});
  }, []);

  const commit = (next) => { itemsRef.current = next; setItems(next); };
  async function addFiles(list) {
    const all = [...list];
    const isPdf = (f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
    const msgs = [];
    // PDF 在浏览器里拆成每页一张图（拍板 6），之后和照片一样质检、上传
    const files = [];
    for (const f of all) {
      if (isPdf(f)) {
        setBusy(`正在拆 PDF「${f.name}」…`);
        try {
          const { pdfToImages } = await import('../../lib/pdf-pages.js');
          const r = await pdfToImages(f, { maxLong: UPLOAD_LONG, maxPages: MAX_PAGES });
          files.push(...r.files);
          msgs.push(`PDF「${f.name}」共 ${r.total} 页${r.total > r.files.length ? `，只取了前 ${r.files.length} 页` : ''}`);
        } catch (e) {
          msgs.push(`PDF「${f.name}」打不开（${String(e.message || e).slice(0, 60)}）`);
        }
        setBusy('');
      } else if ((f.type || '').startsWith('image/') || /\.(jpe?g|png|webp|heic|heif)$/i.test(f.name)) files.push(f);
    }
    const room = Math.max(0, MAX_PAGES - itemsRef.current.length);
    if (files.length + all.filter(isPdf).length < all.length) msgs.push('不是图片、也不是 PDF 的文件没加');
    if (files.length > room) msgs.push(`一次最多 ${MAX_PAGES} 页，多出来的 ${files.length - room} 张没加`);
    const added = files.slice(0, room).map((f) => ({ key: `${f.name}-${f.size}-${Math.random()}`, file: f, name: f.name, url: URL.createObjectURL(f), qc: null }));
    commit([...itemsRef.current, ...added]);
    setError(msgs.join('；'));
    for (const it of added) await check(it.key, it.file);
  }
  async function check(key, file) {
    let res;
    try { res = await assessFile(file); } catch {
      res = { level: 'red', problems: [{ level: 'red', rule: 'unreadable', message: '这张图读不出来（HEIC 请在相册里存成 JPEG 再选）' }] };
    }
    commit(itemsRef.current.map((x) => (x.key === key ? { ...x, w: res.width, h: res.height, qc: res } : x)));
  }
  const move = (i, d) => {
    const next = [...itemsRef.current];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    commit(next);
  };
  const remove = (key) => commit(itemsRef.current.filter((x) => { if (x.key === key) URL.revokeObjectURL(x.url); return x.key !== key; }));
  async function retake(key, file) {
    if (!file) return;
    commit(itemsRef.current.map((x) => (x.key === key ? { ...x, file, name: file.name, url: URL.createObjectURL(file), qc: null } : x)));
    await check(key, file);
  }

  const reds = items.filter((x) => x.qc?.level === 'red').length;
  const checking = items.filter((x) => !x.qc).length;
  const est = estimate(items, cfg?.provider);
  const problems = [];
  if (!subjectCode) problems.push('选一个学科');
  if (!items.length) problems.push('选照片');
  if (checking) problems.push(`还有 ${checking} 张在检查`);
  if (reds) problems.push(`${reds} 张要重拍或删掉（标红的）`);

  async function start() {
    setError('');
    const budget = cfg?.budget;
    const yellows = items.filter((x) => x.qc?.level === 'yellow').length;
    const msg = `共 ${items.length} 页，预计识别花费${est == null ? '未知（「图片解析 AI」没填单价）' : `约 ${est.toFixed(2)} 元`}，另加拆题（看「文字解析 AI」的单价）。` +
      (yellows ? `\n有 ${yellows} 张标黄（拍歪 / 边上可能裁掉），确定看得清再继续。` : '') +
      (budget ? `\n本月已花 ${budget.spent} 元${budget.budget != null ? ` / 上限 ${budget.budget} 元` : ''}。` : '') +
      (budget?.over ? '\n⚠ 本月已经到上限了，继续会接着花。' : '') +
      '\n\n照片传上去后在后台排队识别，关了页面也会继续；识别完照片立刻删掉。开始吗？';
    if (!confirm(msg)) return;
    try {
      setBusy('建任务…');
      const job = await post('/admin/import/jobs', { subjectCode, title: title.trim() || undefined });
      for (const [i, it] of itemsRef.current.entries()) {
        setBusy(`上传第 ${i + 1} / ${itemsRef.current.length} 张…`);
        await put(`/admin/import/jobs/${job.id}/pages/${i + 1}`, { image: await prepareUpload(it.file, UPLOAD_LONG) });
      }
      setBusy('开始识别…');
      await post(`/admin/import/jobs/${job.id}/start`, { estimateYuan: est == null ? null : Number(est.toFixed(4)), confirmOverBudget: Boolean(budget?.over) });
      itemsRef.current.forEach((x) => URL.revokeObjectURL(x.url));
      nav(`/admin/import/${job.id}`);
    } catch (e) {
      setError(e.message);
      setBusy('');
    }
  }

  if (!subjects) return error ? <Alert>{error}</Alert> : <Loading />;
  return (
    <>
      <PageHead title="导入资料（拍照）" desc="拍书页照片，AI 识别、拆成题目，你逐页核对后入库。照片识别完就删，不保存。" />
      <p className="small"><Link to="/admin/bank">← 返回试卷与校对</Link></p>
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {!cfg?.provider && cfg ? <Alert>{cfg.modelsError || '「图片解析 AI」还没配，先到 AI 配置页配好'}</Alert> : null}

      <div className="card card-pad stack" data-testid="import-setup">
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="imp-subject">学科</label>
          <select id="imp-subject" className="input" value={subjectCode} disabled={Boolean(busy)} onChange={(e) => setSubjectCode(e.target.value)}>
            <option value="">请选择</option>
            {subjects.map((s) => <option key={s.code} value={s.code}>{s.name}（{s.code}）</option>)}
          </select>
        </div>
        <div className="field" style={{ marginBottom: 0 }}>
          <label htmlFor="imp-title">这次导入叫什么（可不填）</label>
          <input id="imp-title" className="input" value={title} disabled={Boolean(busy)} placeholder="比如：选择题 第 141–153 页" onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div className="bench-drop" data-testid="import-drop"
          onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); if (!busy) addFiles(e.dataTransfer?.files || []); }}>
          <label className={`btn${items.length ? ' ghost' : ''}${busy || items.length >= MAX_PAGES ? ' disabled' : ''}`}>
            {items.length ? '继续添加照片' : '拍照或选照片 / PDF（可以一次选多张）'}
            <input type="file" accept="image/*,application/pdf,.pdf" multiple className="visually-hidden" data-testid="import-files"
              disabled={Boolean(busy) || items.length >= MAX_PAGES}
              onChange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; addFiles(fs); }} />
          </label>
          <span className="tiny muted" data-testid="import-count">
            已选 {items.length} / {MAX_PAGES} 页。按书上的顺序排（可以上下调）。每张当场检查：太小、拍糊、太暗或反光的要重拍；拍歪、边上可能裁掉的提醒一下。
          </span>
        </div>

        {items.map((it, i) => (
          <div key={it.key} className={`import-item qc-${it.qc?.level || 'wait'}`} data-testid="import-item">
            <img src={it.url} alt={`第 ${i + 1} 张`} />
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="small" style={{ overflowWrap: 'anywhere' }}>
                <strong>第 {i + 1} 张</strong> · {it.name}{it.w ? `（${it.w}×${it.h}）` : ''}
                {' '}{it.qc ? <span className={`badge ${QC_BADGE[it.qc.level][0]}`} data-testid="import-qc">{QC_BADGE[it.qc.level][1]}</span> : <span className="tiny muted">检查中…</span>}
              </div>
              {(it.qc?.problems || []).map((p) => (
                <div key={p.rule} className="tiny" style={{ color: p.level === 'red' ? 'var(--danger)' : 'var(--warn)' }}>{p.message}</div>
              ))}
              <div className="row" style={{ gap: 6, marginTop: 6 }}>
                <button className="btn ghost sm" disabled={Boolean(busy) || i === 0} onClick={() => move(i, -1)} aria-label="上移">↑</button>
                <button className="btn ghost sm" disabled={Boolean(busy) || i === items.length - 1} onClick={() => move(i, 1)} aria-label="下移">↓</button>
                <label className={`btn ghost sm${busy ? ' disabled' : ''}`}>重拍
                  <input type="file" accept="image/*" className="visually-hidden" data-testid="import-retake"
                    onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; retake(it.key, f); }} />
                </label>
                <button className="btn ghost sm" disabled={Boolean(busy)} onClick={() => remove(it.key)}>去掉</button>
              </div>
            </div>
          </div>
        ))}

        <p className="small" data-testid="import-estimate">
          共 <strong>{items.length}</strong> 页；识别预计 {est == null ? '花费未知（「图片解析 AI」没填单价）' : `约 ${est.toFixed(2)} 元`}
          {cfg?.budget ? `；本月已花 ${cfg.budget.spent} 元${cfg.budget.budget != null ? ` / 上限 ${cfg.budget.budget} 元` : ''}` : ''}
        </p>
        {problems.length && !busy ? <p className="small" style={{ color: 'var(--warn)', margin: 0 }} data-testid="import-problems">还差：{problems.join('；')}</p> : null}
        {busy ? <p className="small" data-testid="import-busy">{busy}</p> : null}
        <div className="sticky-actions">
          <button className="btn" data-testid="import-start" disabled={Boolean(busy) || problems.length > 0 || !cfg?.provider} onClick={start}>
            {busy ? '上传中…' : '开始识别'}
          </button>
        </div>
      </div>

      {jobs.length ? (
        <div className="card card-pad" style={{ marginTop: 16 }}>
          <h2 style={{ fontSize: 15, marginTop: 0 }}>最近的导入</h2>
          <div className="stack">
            {jobs.map((j) => (
              <Link key={j.job_id} to={`/admin/import/${j.job_id}`} className="small" data-testid="import-job-link" style={{ display: 'block', overflowWrap: 'anywhere' }}>
                {formatBeijing(j.created_at)} · {j.subject_name} · {j.title} · <span className="badge gray">{j.status}</span> · {j.pages_done}/{j.page_count} 页 · {yuan(j.cost_yuan)}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </>
  );
}

export function ImportJob() {
  const { jobId } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [pageIdx, setPageIdx] = useState(0);
  const [busy, setBusy] = useState('');
  const [committed, setCommitted] = useState(null);

  const load = () => get(`/admin/import/jobs/${jobId}`).then((d) => { setData(d); return d; }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, [jobId]);
  // 排队识别、拆题时每 5 秒看一次进度（后台在跑，关了页面也继续）
  useEffect(() => {
    if (!data || !BUSY.includes(data.job.status)) return undefined;
    const t = setTimeout(load, 5000);
    return () => clearTimeout(t);
  }, [data]);

  const pages = data?.pages || [];
  const issues = data?.issues || [];
  const pending = (p) => issues.filter((i) => !i.resolved && i.pageNo === p.pageNo);
  const shown = useMemo(() => (onlyIssues ? pages.filter((p) => pending(p).length) : pages), [data, onlyIssues]);
  const cur = shown[Math.min(pageIdx, Math.max(0, shown.length - 1))];

  async function act(label, fn) {
    setError(''); setMsg(''); setBusy(label);
    try { const r = await fn(); await load(); return r; } catch (e) { setError(e.message); return null; } finally { setBusy(''); }
  }

  if (error && !data) return <Alert>{error}</Alert>;
  if (!data) return <Loading />;
  const { job, progress } = data;
  const left = progress.queued;
  return (
    <>
      <PageHead title={job.title} desc={`${job.subjectName} · AI 拆题导入`} />
      <p className="small"><Link to="/admin/import/new">← 导入资料</Link></p>
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {msg ? <div style={{ marginBottom: 12 }}><Alert kind="success">{msg}</Alert></div> : null}

      <div className="card card-pad" data-testid="import-progress" style={{ marginBottom: 12 }}>
        <div className="spread">
          <span><span className="badge info" data-testid="import-status">{job.status}</span></span>
          <span className="small muted">已花 {yuan(job.costYuan)}{job.estCostYuan != null ? `（预计 ${yuan(job.estCostYuan)}）` : ''}</span>
        </div>
        <p className="small" style={{ margin: '8px 0 0' }}>
          已识别 {progress.recognized} / 共 {progress.total} 页{progress.failed ? ` · 失败 ${progress.failed} 页` : ''}
          {BUSY.includes(job.status) ? (job.status === '拆题中' ? ' · 正在拆题…' : ` · 预计还要 ${Math.max(1, Math.ceil(left / 4))} 分钟左右`) : ''}
        </p>
        {BUSY.includes(job.status) ? <p className="tiny muted" style={{ margin: '4px 0 0' }}>后台排队识别，关了页面也会继续；识别完照片立刻删掉。</p> : null}
        {job.status === '失败' ? (
          <>
            <p className="small" style={{ color: 'var(--danger)' }}>{job.error}</p>
            <button className="btn sm" disabled={Boolean(busy)} onClick={() => act('重新拆题', () => post(`/admin/import/jobs/${jobId}/resplit`))}>重新拆题</button>
          </>
        ) : null}
        {job.status === '已入库' || committed ? (
          <p className="small" data-testid="import-done">已入库。<Link to={`/admin/bank/${committed?.examId || job.examId}`}>去校对页</Link> 补答案、发布。</p>
        ) : null}
        {!['已入库', '已放弃'].includes(job.status) ? (
          <button className="btn ghost sm" style={{ marginTop: 8 }} disabled={Boolean(busy)}
            onClick={() => confirm('放弃这次导入？排队的照片会一并删掉。') && act('放弃', () => post(`/admin/import/jobs/${jobId}/abandon`))}>放弃这次导入</button>
        ) : null}
      </div>

      {job.status === '待核对' && data.draft ? (
        <Review data={data} jobId={jobId} cur={cur} shown={shown} pageIdx={Math.min(pageIdx, Math.max(0, shown.length - 1))}
          setPageIdx={setPageIdx} onlyIssues={onlyIssues} setOnlyIssues={(v) => { setOnlyIssues(v); setPageIdx(0); }}
          busy={busy} act={act} setMsg={setMsg} onCommitted={setCommitted} />
      ) : null}
    </>
  );
}

function Review({ data, jobId, cur, shown, pageIdx, setPageIdx, onlyIssues, setOnlyIssues, busy, act, setMsg, onCommitted }) {
  const { issues, pendingIssues, draft, types } = data;
  const jobIssues = issues.filter((i) => i.pageNo == null || i.scope === 'job');
  const qsOn = (p) => draft.sections.flatMap((s, si) => s.questions.map((q) => ({ ...q, si, section: s }))).filter((q) => q.pageNo === p.pageNo);
  const resolve = (ids) => act('处理可疑处', () => post(`/admin/import/jobs/${jobId}/issues/resolve`, { ids }));
  async function retakePage(file) {
    if (!file) return;
    const edited = cur ? qsOn(cur).filter((q) => (draft.edited || {})[q.id]).length : 0;
    if (edited && !confirm(`这一页你改过 ${edited} 道题，重拍会用新识别的结果覆盖。继续吗？`)) return;
    const qc = await assessFile(file).catch(() => null);
    if (qc?.level === 'red') { alert(`这张也不行：${qc.problems.map((p) => p.message).join('；')}`); return; }
    const image = await prepareUpload(file, UPLOAD_LONG);
    const r = await act('重拍', () => put(`/admin/import/jobs/${jobId}/pages/${cur.pageNo}/retake`, { image }));
    if (r) setMsg(`第 ${cur.pageNo} 张已重新排队识别，识别完会替换这一页的题`);
  }
  async function commit() {
    const r = await act('入库', () => post(`/admin/import/jobs/${jobId}/commit`));
    if (!r) return;
    onCommitted(r);
    setMsg(`已入库 ${r.questions} 道题，正在生成答案和解析…`);
    try {
      const a = await post(`/admin/bank/exams/${r.examId}/ai-answers`);
      setMsg(`已入库 ${r.questions} 道题；AI 生成了 ${a.generated} / ${a.attempted} 道的答案和解析（待你核对）。`);
    } catch (e) {
      setMsg(`已入库 ${r.questions} 道题；生成答案这一步没成功（${e.message}），可以到校对页再点「AI 生成答案」。`);
    }
  }

  return (
    <div data-testid="import-review">
      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <div className="spread">
          <strong className="small" data-testid="review-head">第 {cur ? cur.pageNo : '—'}/{data.pages.length} 张 · 还剩 {pendingIssues} 处可疑</strong>
          <label className="small row" style={{ gap: 6 }}>
            <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} data-testid="review-only-issues" /> 只看有可疑处的页
          </label>
        </div>
        {jobIssues.filter((i) => !i.resolved).map((i) => (
          <IssueLine key={i.id} issue={i} busy={busy} onOk={() => resolve([i.id])} />
        ))}
        <div className="row" style={{ gap: 6, marginTop: 8 }}>
          <button className="btn ghost sm" disabled={pageIdx <= 0} onClick={() => setPageIdx(pageIdx - 1)}>上一页</button>
          <button className="btn ghost sm" disabled={pageIdx >= shown.length - 1} onClick={() => setPageIdx(pageIdx + 1)} data-testid="review-next">下一页</button>
          <span className="tiny muted">{shown.length ? `${pageIdx + 1} / ${shown.length}${onlyIssues ? '（有可疑处的页）' : ''}` : '没有要看的页'}</span>
        </div>
      </div>

      {cur ? (
        <div className="card card-pad stack" data-testid="review-page">
          <div className="spread">
            <strong>第 {cur.pageNo} 张{cur.printedPage ? `（书上第 ${cur.printedPage} 页）` : ''}</strong>
            {cur.status === '失败' ? <span className="badge danger">识别失败</span> : null}
          </div>
          {issues.filter((i) => i.pageNo === cur.pageNo && !i.qid && !i.resolved && i.scope !== 'job').map((i) => (
            <IssueLine key={i.id} issue={i} busy={busy} onOk={() => resolve([i.id])} />
          ))}
          {issues.filter((i) => i.pageNo === cur.pageNo && !i.resolved).length === 0 ? <p className="small" style={{ color: 'var(--ok)', margin: 0 }} data-testid="review-clean">本页没有可疑处</p> : null}
          {qsOn(cur).map((q) => (
            <QuestionEditor key={`${q.id}-${q.stem}-${(q.options || []).join('|')}-${q.no}-${q.questionType}`} q={q} types={types} jobId={jobId}
              issues={issues.filter((i) => i.qid === q.id && !i.resolved)} edited={(draft.edited || {})[q.id]}
              busy={busy} act={act} resolve={resolve} />
          ))}
          {!qsOn(cur).length && cur.status !== '失败' ? <p className="small muted">这一页没有拆出题（说明、页眉之类）。</p> : null}
          <details>
            <summary className="small">看这一页识别出的原文</summary>
            <pre className="bench-text" style={{ whiteSpace: 'pre-wrap' }}>{cur.text || '（没有识别出文字）'}</pre>
            {cur.textAlt ? (<><div className="tiny muted">第二遍识别：</div><pre className="bench-text" style={{ whiteSpace: 'pre-wrap' }}>{cur.textAlt}</pre></>) : null}
          </details>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn sm" data-testid="review-page-ok" disabled={Boolean(busy)} onClick={() => act('这页没问题', () => post(`/admin/import/jobs/${jobId}/pages/${cur.pageNo}/ok`))}>这页没问题</button>
            <label className={`btn ghost sm${busy ? ' disabled' : ''}`}>这页重拍
              <input type="file" accept="image/*" className="visually-hidden" data-testid="review-retake"
                onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; retakePage(f); }} />
            </label>
          </div>
        </div>
      ) : null}

      <div className="sticky-actions">
        <button className="btn" data-testid="review-commit" disabled={Boolean(busy) || pendingIssues > 0} onClick={commit}>
          {pendingIssues > 0 ? `入库（还剩 ${pendingIssues} 处可疑）` : '入库'}
        </button>
      </div>
    </div>
  );
}

function IssueLine({ issue, busy, onOk }) {
  return (
    <div className={`import-issue ${issue.level}`} data-testid="review-issue">
      <span className="small" style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{issue.message}</span>
      {issue.rule !== 'type' ? <button className="btn ghost sm" disabled={Boolean(busy)} onClick={onOk} data-testid="review-issue-ok">没问题</button> : null}
    </div>
  );
}

function QuestionEditor({ q, types, jobId, issues, edited, busy, act, resolve }) {
  const [no, setNo] = useState(q.no ?? '');
  const [type, setType] = useState(q.questionType);
  const [stem, setStem] = useState(q.stem || '');
  const [opts, setOpts] = useState((q.options || []).join('\n'));
  const dirty = String(no) !== String(q.no ?? '') || type !== q.questionType || stem !== (q.stem || '') || opts !== (q.options || []).join('\n');
  const save = () => act('保存', () => patch(`/admin/import/jobs/${jobId}/questions/${q.id}`, {
    no: no === '' ? null : Number(no), questionType: type, stem, options: opts.trim() ? opts.split('\n').map((x) => x.trim()).filter(Boolean) : null,
  }));
  return (
    <div className={`import-q${issues.length ? ' suspect' : ''}`} data-testid="review-question">
      {issues.map((i) => <IssueLine key={i.id} issue={i} busy={busy} onOk={() => resolve([i.id])} />)}
      <div className="row" style={{ gap: 8 }}>
        <input className="input" style={{ width: 80 }} inputMode="numeric" aria-label="题号" value={no} onChange={(e) => setNo(e.target.value)} />
        <select className="input" style={{ flex: 1, minWidth: 0 }} aria-label="题型" value={type} onChange={(e) => setType(e.target.value)}>
          {types.map((t) => <option key={t.code} value={t.code}>{t.name}</option>)}
          {!types.some((t) => t.code === type) ? <option value={type}>{type}（这门课没有）</option> : null}
        </select>
      </div>
      <textarea className="input" rows={2} aria-label="题干" value={stem} onChange={(e) => setStem(e.target.value)} data-testid="review-stem" />
      <textarea className="input" rows={Math.max(2, opts.split('\n').length)} aria-label="选项（一行一个）" placeholder="选项，一行一个（没有就空着）" value={opts} onChange={(e) => setOpts(e.target.value)} />
      <div className="row" style={{ gap: 8 }}>
        <button className="btn sm" disabled={!dirty || Boolean(busy)} onClick={save} data-testid="review-save">保存</button>
        <button className="btn ghost sm" disabled={Boolean(busy)} onClick={() => confirm('删掉这一道？（页眉、说明被当成了题时用）') && act('删题', () => api(`/admin/import/jobs/${jobId}/questions/${q.id}`, { method: 'DELETE' }))}>删掉这道</button>
        {edited?.length ? <span className="tiny muted">改过：{edited.join('、')}</span> : null}
      </div>
    </div>
  );
}
