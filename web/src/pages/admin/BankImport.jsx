import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { get, post, postRaw } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

// 后台上传原始资料（§6.4.3、N6b）。
//
// 三步，每一步的结果都摆出来再往下走：
//   ① 试解析（dryRun）——出题数、空数、按题型分布、解析记录，**不写库**
//   ② 确认入库——题面落库，答案一律「缺答案」
//   ③ 自动接着调 AI 生成候选答案——落「待核」，**发不出去**，要逐题人工确认
//
// 为什么不一把梭：解析结果对不对，只有人看了才知道。第 9 题的选项标号被自动订正过
// 这种事，得让人在入库前看见。

const GROUP_ID_RE = /^[a-z][a-z0-9-]{1,63}$/;

export default function BankImport() {
  const navigate = useNavigate();
  const [subjects, setSubjects] = useState(null);
  const [form, setForm] = useState({ subjectCode: '', groupId: '', label: '', orderKey: '' });
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [aiResult, setAiResult] = useState(null);
  const [busy, setBusy] = useState('');       // '' | 'dry' | 'commit' | 'ai'
  const [error, setError] = useState('');
  const fileRef = useRef(null);

  useEffect(() => {
    get('/admin/subjects')
      .then((r) => {
        const list = (r.subjects || []).filter((s) => s.status === '启用');
        setSubjects(list);
        if (list.length === 1) set('subjectCode', list[0].code);
      })
      .catch((e) => setError(e.message));
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const qs = useMemo(() => new URLSearchParams({
    subjectCode: form.subjectCode,
    groupId: form.groupId.trim(),
    label: form.label.trim(),
    orderKey: String(form.orderKey).trim(),
    filename: file?.name || '',
  }).toString(), [form, file]);

  // 三个字段各自的问题分开说。合成一句"请填写完整"的话，人得挨个试才知道是哪个。
  const problems = [];
  if (!form.subjectCode) problems.push('选一个学科');
  if (!GROUP_ID_RE.test(form.groupId.trim())) problems.push('内容组 id 需为小写字母开头、2-64 位的小写字母/数字/连字符');
  if (!form.label.trim()) problems.push('填一个显示名');
  if (!/^-?\d+$/.test(String(form.orderKey).trim())) problems.push('排序依据要是整数（生化按章节号）');
  if (!file) problems.push('选一个文件');

  async function run(kind) {
    setError(''); setBusy(kind);
    try {
      if (kind === 'dry') {
        setPreview(await postRaw(`/admin/bank/import?${qs}&dryRun=1`, file));
      } else {
        const r = await postRaw(`/admin/bank/import?${qs}`, file);
        setResult(r);
        // 接着自动生成候选答案。**这一步失败不算整件事失败**：题面已经入库了。
        setBusy('ai');
        try {
          setAiResult(await post(`/admin/bank/exams/${r.groupId}/ai-answers`));
        } catch (e) {
          setAiResult({ ok: false, failedWholeStep: e.message });
        }
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  }

  if (error && !subjects) return <Alert>{error}</Alert>;
  if (!subjects) return <Loading />;

  return (
    <>
      <PageHead title="上传题库" desc="传一份原始资料，解析成题目入库。答案要另外录，录完确认才能发布。" />
      <p className="small">
        <Link to="/admin/bank">← 返回试卷与校对</Link>
      </p>

      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="field">
          <label htmlFor="imp-subject">学科</label>
          <select id="imp-subject" className="input" value={form.subjectCode}
            disabled={Boolean(busy)}
            onChange={(e) => set('subjectCode', e.target.value)}>
            <option value="">请选择</option>
            {subjects.map((s) => (
              <option key={s.code} value={s.code}>{s.name}（{s.code}）</option>
            ))}
          </select>
          <p className="tiny faint" style={{ marginTop: 4 }}>
            用哪条解析管线由学科决定。英语走的是扫描件 OCR 那条，本系统里没有实现，选了会被拒。
          </p>
        </div>

        <div className="field">
          <label htmlFor="imp-gid">内容组 id</label>
          <input id="imp-gid" className="input" value={form.groupId} disabled={Boolean(busy)}
            placeholder="biochem-ch02" onChange={(e) => set('groupId', e.target.value)} />
          <p className="tiny faint" style={{ marginTop: 4 }}>
            进 URL、进主键，建好之后改不了。同一个 id 只能传一次。
          </p>
        </div>

        <div className="field">
          <label htmlFor="imp-label">显示名</label>
          <input id="imp-label" className="input" value={form.label} disabled={Boolean(busy)}
            placeholder="第02章 核酸的化学" onChange={(e) => set('label', e.target.value)} />
        </div>

        <div className="field">
          <label htmlFor="imp-order">排序依据</label>
          <input id="imp-order" className="input" inputMode="numeric" value={form.orderKey}
            disabled={Boolean(busy)} placeholder="2"
            onChange={(e) => set('orderKey', e.target.value)} />
          <p className="tiny faint" style={{ marginTop: 4 }}>
            列表按它排序。按教材章节组织的学科填章节号。
          </p>
        </div>

        <div className="field">
          <label htmlFor="imp-file">原始资料</label>
          <input id="imp-file" ref={fileRef} type="file" className="input" accept=".docx"
            disabled={Boolean(busy)}
            onChange={(e) => { setFile(e.target.files?.[0] || null); setPreview(null); }} />
          <p className="tiny faint" style={{ marginTop: 4 }}>
            <strong>解析完原件就丢弃</strong>，只留抽出来的文字。所以请自己留一份底稿——
            解析器将来改进了，要重新解析得请你再传一次。
          </p>
        </div>

        {problems.length && !result ? (
          <p className="small" style={{ color: 'var(--warn)' }}>还差：{problems.join('；')}</p>
        ) : null}

        {!result ? (
          <div className="sticky-actions">
            <button className="btn ghost" disabled={Boolean(busy) || problems.length}
              onClick={() => run('dry')}>
              {busy === 'dry' ? '解析中…' : '试解析（不入库）'}
            </button>
            <button className="btn" disabled={Boolean(busy) || problems.length || !preview}
              onClick={() => run('commit')}>
              {busy === 'commit' ? '入库中…' : busy === 'ai' ? '生成候选答案中…' : '确认入库'}
            </button>
          </div>
        ) : null}
      </div>

      {preview && !result ? <ParseReport title="试解析结果（还没入库）" data={preview} /> : null}

      {result ? (
        <>
          <Alert kind="success">
            已入库 {result.questions} 道题。答案一律「缺答案」，
            {aiResult?.ok
              ? ` AI 生成了 ${aiResult.generated} 道候选答案，全部落在「待核」。`
              : ' 还没有答案。'}
            <strong>逐题人工确认之后才能发布。</strong>
          </Alert>
          <ParseReport title="入库结果" data={result} />
          {aiResult ? <AiReport data={aiResult} /> : null}
          <div className="sticky-actions">
            <button className="btn" onClick={() => navigate(`/admin/bank/${result.groupId}`)}>
              去校对这一章
            </button>
            <button className="btn ghost" onClick={() => {
              setResult(null); setAiResult(null); setPreview(null); setFile(null);
              setForm((f) => ({ ...f, groupId: '', label: '', orderKey: '' }));
              if (fileRef.current) fileRef.current.value = '';
            }}>再传一章</button>
          </div>
        </>
      ) : null}
    </>
  );
}

function ParseReport({ title, data }) {
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>{title}</h2>
      <div className="grid-cards" style={{ marginBottom: 12 }}>
        <Stat label="题目" value={data.questions} />
        <Stat label="填空的空" value={data.blanks} />
        <Stat label="原文段落" value={data.paragraphs} />
        <Stat label="没有考点" value={data.questionsWithoutTags} warn={data.questionsWithoutTags > 0} />
      </div>
      {data.questionsWithoutTags > 0 ? (
        <p className="tiny muted">
          没有考点的题不会进专项练习（练习按考点抽题）。校对时补上标签。
        </p>
      ) : null}

      <div style={{ overflowX: 'auto', marginBottom: 12 }}>
        <table className="table responsive">
          <thead><tr><th>题型分组</th><th>题数</th></tr></thead>
          <tbody>
            {(data.perSection || []).map((s) => (
              <tr key={s.type}>
                <td data-label="题型分组">{s.type}</td>
                <td data-label="题数">{s.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(data.parsingNotes || []).length ? (
        <>
          <h3 style={{ fontSize: 14, marginBottom: 8 }}>解析时记下的问题（{data.parsingNotes.length} 条）</h3>
          <div className="stack">
            {data.parsingNotes.map((n, i) => (
              <div key={i} className="small" style={{ borderLeft: '3px solid var(--line)', paddingLeft: 10 }}>
                <span className={`badge ${n.kind === '原题有误' ? 'warn' : 'gray'}`}
                  style={{ marginRight: 6 }}>{n.kind}</span>
                {n.note}
                {n.correctedFrom ? (
                  <span className="tiny faint" style={{ display: 'block', marginTop: 4 }}>
                    订正前：{n.correctedFrom}<br />订正后：{n.correctedTo}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </>
      ) : <p className="small faint">解析时没有记下问题。</p>}
    </div>
  );
}

function AiReport({ data }) {
  if (data.failedWholeStep) {
    return (
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <h2 style={{ fontSize: 16, marginBottom: 8 }}>AI 候选答案</h2>
        <Alert>这一步没跑成：{data.failedWholeStep}</Alert>
        <p className="small">
          题面已经入库了，不受影响。配好 AI 之后可以在校对页重试，也可以直接人工录答案。
        </p>
      </div>
    );
  }
  return (
    <div className="card card-pad" style={{ marginBottom: 16 }}>
      <h2 style={{ fontSize: 16, marginBottom: 12 }}>AI 候选答案</h2>
      <p className="small">
        生成 {data.generated} / {data.attempted} 道，全部落在「待核」。
        {data.failures?.length ? ` 另有 ${data.failures.length} 道没生成出来，仍是「缺答案」。` : ''}
        {data.withoutExplanation?.length
          ? ` 其中 ${data.withoutExplanation.length} 道只有答案、没有解析，校对时可以补。` : ''}
      </p>
      {/* 实际用的是哪一档配置要显眼。回落时管理员以为在用自己配的模型，
          而时延、账单、效果都来自另一个——不说出来，这三样对不上时没有任何线索。 */}
      {data.purpose ? (
        <p className="tiny faint">
          用的是{data.purpose === 'PARSING' ? '「图片解析 AI」' : '「文字解析 AI」'}
          （这份资料是{data.mediaKind === 'image' ? '图片型' : '文字型'}）
          {data.purposeFellBack
            ? '　⚠ 这一档没配，沿用了上一档的配置——视觉模型做纯文字活通常更贵更慢，建议单独配一个。'
            : ''}
        </p>
      ) : null}
      {data.failures?.length ? (
        <div style={{ overflowX: 'auto', marginTop: 8 }}>
          <table className="table responsive">
            <thead><tr><th>题号</th><th>原因</th></tr></thead>
            <tbody>
              {data.failures.slice(0, 20).map((f) => (
                <tr key={f.questionId}>
                  <td data-label="题号">第 {f.ord} 题</td>
                  <td data-label="原因"><span className="tiny">{f.message || f.reason}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value, warn }) {
  return (
    <div className="card card-pad">
      <div className="tiny muted">{label}</div>
      <div style={{ fontSize: 24, fontWeight: 600, color: warn ? 'var(--warn)' : undefined }}>
        {value ?? 0}
      </div>
    </div>
  );
}
