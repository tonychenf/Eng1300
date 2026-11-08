import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { get, post, put } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

// 开一门新课（改进阶段 2 P1-A1、L2）。两个路由共用这一页：
//   /admin/subjects/new          ① 建课表单
//   /admin/subjects/:id/setup    六步引导：建课 → 传资料 → 核答案 → 配组卷 → 发布 → 开通学员
// 每一步"做完没有"都由上线清单（GET /admin/subjects/:id/checklist）现算，不在页面上另存状态。

export function SubjectNew() {
  const navigate = useNavigate();
  const [subjects, setSubjects] = useState(null);
  const [form, setForm] = useState({ name: '', code: '', copyFrom: '', totalScore: 100, timeLimitMinutes: 120 });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([get('/admin/subjects'), get('/admin/subjects/suggest-code')])
      .then(([s, c]) => {
        setSubjects((s.subjects || []).filter((x) => x.status === '启用'));
        setForm((f) => ({ ...f, code: c.code }));
      })
      .catch((e) => setError(e.message));
  }, []);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  async function create(e) {
    e.preventDefault();
    setError(''); setBusy(true);
    try {
      const r = await post('/admin/subjects', {
        name: form.name.trim(), code: form.code.trim(), copyFrom: form.copyFrom || null,
        totalScore: Number(form.totalScore), timeLimitMinutes: Number(form.timeLimitMinutes),
      });
      navigate(`/admin/subjects/${r.subject.subjectId}/setup`, {
        state: { copiedPrompts: r.copiedPrompts, copiedFrom: r.copiedFrom },
      });
    } catch (err) { setError(err.message); setBusy(false); }
  }

  if (!subjects && !error) return <Loading />;
  return (
    <>
      <PageHead title="开一门新课" desc="建好之后按六步走完就能给学员用：传资料、核答案、配组卷、发布、开通" />
      <p className="small"><Link to="/admin/subjects">← 返回学科管理</Link></p>
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      <form className="card card-pad stack" onSubmit={create} data-testid="subject-new-form">
        <div className="field">
          <label htmlFor="sn-name">学科名</label>
          <input id="sn-name" className="input" value={form.name} maxLength={20} required
            placeholder="如：大学语文" onChange={(e) => set('name', e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="sn-code">学科码</label>
          <input id="sn-code" className="input" value={form.code} required autoCapitalize="none"
            onChange={(e) => set('code', e.target.value.toLowerCase())} />
          <p className="tiny faint" style={{ marginTop: 4 }}>
            会出现在网址里，<strong>建好后不能改</strong>。建议改成好记的英文，如 chinese。
          </p>
        </div>
        <div className="field">
          <label htmlFor="sn-copy">参照哪门课</label>
          <select id="sn-copy" className="input" value={form.copyFrom} onChange={(e) => set('copyFrom', e.target.value)}>
            <option value="">不参照（用单选、填空、简答三种通用题型）</option>
            {(subjects || []).map((s) => <option key={s.code} value={s.code}>{s.name}</option>)}
          </select>
          <p className="tiny faint" style={{ marginTop: 4 }}>
            复制它的题型、评分规则和 AI 提示词；题目、考点、组卷模板、学员不复制。
          </p>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="sn-total">满分</label>
            <input id="sn-total" className="input" inputMode="numeric" value={form.totalScore}
              onChange={(e) => set('totalScore', e.target.value)} />
          </div>
          <div className="field" style={{ flex: '1 1 140px' }}>
            <label htmlFor="sn-time">考试时长（分钟）</label>
            <input id="sn-time" className="input" inputMode="numeric" value={form.timeLimitMinutes}
              onChange={(e) => set('timeLimitMinutes', e.target.value)} />
          </div>
        </div>
        <div className="sticky-actions">
          <button className="btn" type="submit" disabled={busy || !form.name.trim() || !form.code.trim()}>
            {busy ? '建课中…' : '建课'}
          </button>
        </div>
      </form>
    </>
  );
}

const STEPS = [
  { key: 'create', title: '建课', done: () => true },
  { key: 'upload', title: '传资料', done: (c) => c.items.groups > 0 },
  { key: 'answers', title: '核答案', done: (c) => c.items.groups > 0 && c.items.pendingAnswers === 0 },
  { key: 'template', title: '配组卷', done: (c) => c.items.templateOk },
  { key: 'publish', title: '发布', done: (c) => c.items.publishedQuestions > 0 && c.items.unpublishedGroups === 0 },
  { key: 'grant', title: '开通学员', done: (c) => c.items.students > 0 },
];

const STATE_TEXT = { not_usable: '还不能用', practice_only: '能练习、还不能模考', ready: '已就绪' };

export function SubjectSetup() {
  const { id } = useParams();
  const [cl, setCl] = useState(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState('');
  const [grantOpen, setGrantOpen] = useState(false);
  const navState = useLocation().state || null;

  const load = useCallback(() => get(`/admin/subjects/${id}/checklist`).then(setCl).catch((e) => setError(e.message)), [id]);
  useEffect(() => { load(); }, [load]);

  // 一键发布：服务端一次最多发 5 组，剩下的接着调
  async function publishAll() {
    setError(''); setMsg(''); setBusy('publish');
    const published = []; const held = []; const skip = [];
    try {
      for (let round = 0; round < 50; round++) {
        const r = await post(`/admin/subjects/${id}/publish-all`, { skip });
        published.push(...r.published); held.push(...r.held);
        skip.push(...r.held.map((h) => h.examId));
        if (!r.remaining) break;
      }
      const n = published.reduce((a, p) => a + (p.count || 0), 0);
      const kept = published.reduce((a, p) => a + (p.heldNoAnswer || 0), 0);
      // 先把清单读回来再报结果：不然提示说"发布了"，上面的状态徽章还写着"还不能用"
      await load();
      setMsg(`发布了 ${published.length} 组、${n} 道题${kept ? `；${kept} 道答案未确认被扣下` : ''}` +
        `${held.length ? `；${held.length} 组没发出去：${held.map((h) => `${h.label}（${h.message}）`).join('；')}` : ''}`);
    } catch (e) { setError(e.message); await load(); }
    setBusy('');
  }

  async function togglePracticeAi() {
    setBusy('ai');
    try { await put(`/admin/subjects/${id}/settings/practice-ai`, { enabled: !cl.subject.practiceAiGrading }); }
    catch (e) { setError(e.message); }
    setBusy(''); load();
  }

  if (error && !cl) return <Alert>{error}</Alert>;
  if (!cl) return <Loading />;
  const s = cl.subject;
  const firstUndone = STEPS.findIndex((st) => !st.done(cl));

  const action = (key) => {
    switch (key) {
      case 'upload': return <Link className="btn sm" to={`/admin/bank/import?subject=${s.code}`}>传题库文件</Link>;
      case 'answers': return <Link className="btn sm" to={`/admin/bank?course=${cl.course?.courseCode || ''}`}>去核答案</Link>;
      case 'template': return <Link className="btn sm" to={`/admin/subjects/${id}/template`}>配组卷模板</Link>;
      case 'publish': return (
        <button className="btn sm" onClick={publishAll} disabled={Boolean(busy)} data-testid="publish-all">
          {busy === 'publish' ? '发布中…' : '一键发布已确认的题'}
        </button>
      );
      case 'grant': return <button className="btn sm" onClick={() => setGrantOpen(true)} data-testid="open-grant">开通学员</button>;
      default: return null;
    }
  };
  const detail = (key) => {
    const it = cl.items;
    switch (key) {
      case 'create': return `满分 ${cl.course?.totalScore} 分 · ${cl.course?.timeLimitMinutes} 分钟`;
      case 'upload': return it.groups ? `已传 ${it.groups} 组` : '还没有传题（扫描件、照片、Word 导入在第三期）';
      case 'answers': return it.pendingAnswers ? `还差 ${it.pendingAnswers} 道题待确认` : (it.groups ? '答案都确认了' : '');
      case 'template': return it.templateItems
        ? (it.templateOk ? (it.examReady ? '模板配好了，能组出卷' : `模板配好了，题还不够：${it.examShortages.join('、')}`)
          : `模板加起来 ${it.templateTotal} 分，和满分 ${cl.course?.totalScore} 对不上`)
        : '还没配';
      case 'publish': return it.unpublishedGroups ? `${it.unpublishedGroups} 组有已确认的题还没发布` : `已发布 ${it.publishedQuestions} 道`;
      case 'grant': return `${it.students} 名学员已开通${s.autoGrantNewUsers ? '；以后新建的学员也自动开通' : ''}`;
      default: return '';
    }
  };

  return (
    <>
      <PageHead title={`开新课：${s.name}`} desc={cl.summary} />
      <p className="small"><Link to="/admin/subjects">← 返回学科管理</Link></p>
      {navState?.copiedPrompts?.length ? (
        <div style={{ marginBottom: 12 }}>
          <Alert kind="info">
            这门课的 {navState.copiedPrompts.length} 条 AI 提示词是从「{navState.copiedFrom?.name}」复制的，学科名已经换好。
            如果里面还有只适合原学科的说法，到 <Link to={`/admin/subjects/${id}/pack`}>能力包</Link> 里改一下。
          </Alert>
        </div>
      ) : null}
      {error ? <div style={{ marginBottom: 12 }}><Alert>{error}</Alert></div> : null}
      {msg ? <div style={{ marginBottom: 12 }}><Alert kind="success">{msg}</Alert></div> : null}

      <div className="card card-pad" style={{ marginBottom: 12 }}>
        <span className={`badge ${cl.state === 'ready' ? 'ok' : cl.state === 'practice_only' ? 'warn' : 'gray'}`} data-testid="setup-state">
          {STATE_TEXT[cl.state]}
        </span>
      </div>

      <ol className="setup-steps">
        {STEPS.map((st, i) => {
          const done = st.done(cl);
          return (
            <li key={st.key} className={`card card-pad setup-step${done ? ' done' : ''}${i === firstUndone ? ' current' : ''}`}
              data-testid={`step-${st.key}`}>
              <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
                <div>
                  <span className="step-num">{done ? '✓' : i + 1}</span>
                  <strong>{st.title}</strong>
                  <div className="tiny muted" style={{ marginTop: 4 }}>{detail(st.key)}</div>
                </div>
                {action(st.key)}
              </div>
            </li>
          );
        })}
      </ol>

      <div className="card card-pad" style={{ marginTop: 12 }}>
        <div className="spread" style={{ gap: 8, flexWrap: 'wrap' }}>
          <div>
            <strong className="small">练习里翻译、简答这类题当场 AI 批改</strong>
            <div className="tiny muted">每个学员每天最多 100 道；关掉后练习里只列采分点让学员自己对照。</div>
          </div>
          <button className="btn ghost sm" onClick={togglePracticeAi} disabled={Boolean(busy)} data-testid="toggle-practice-ai">
            {s.practiceAiGrading ? '已开 · 点击关闭' : '已关 · 点击打开'}
          </button>
        </div>
      </div>

      {grantOpen ? <GrantDialog subject={s} onClose={() => { setGrantOpen(false); load(); }} /> : null}
    </>
  );
}

// 一键开通（P1-E2）。开通走现有的成员接口，一批 15 人（免费计划每次调用的子请求有上限）
function GrantDialog({ subject, onClose }) {
  const [users, setUsers] = useState(null);
  const [picked, setPicked] = useState(new Set());
  // 北京时间的哪一天（YYYY-MM-DD），服务端换成那一天结束的世界时存
  const [untilDay, setUntilDay] = useState('');
  const [auto, setAuto] = useState(subject.autoGrantNewUsers);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    get('/admin/users').then((r) => setUsers((r.users || []).filter((u) => u.role === 'USER' && !u.disabled)))
      .catch((e) => setError(e.message));
  }, []);
  const all = users && picked.size === users.length && users.length > 0;
  const toggle = (name) => setPicked((p) => { const n = new Set(p); if (n.has(name)) n.delete(name); else n.add(name); return n; });

  async function go() {
    setBusy(true); setError('');
    try {
      const names = [...picked];
      for (let i = 0; i < names.length; i += 15) {
        await post(`/admin/subjects/${subject.subjectId}/members`, { usernames: names.slice(i, i + 15), expiresAt: untilDay || null });
      }
      if (auto !== subject.autoGrantNewUsers) {
        await put(`/admin/subjects/${subject.subjectId}/settings/auto-grant`, { enabled: auto });
      }
      onClose();
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <div className="card card-pad" style={{ marginTop: 12 }} data-testid="grant-dialog">
      <h2 style={{ fontSize: 16, marginTop: 0 }}>给学员开通「{subject.name}」</h2>
      {error ? <Alert>{error}</Alert> : null}
      {!users ? <Loading /> : (
        <>
          <label className="choice">
            <input type="checkbox" checked={all} onChange={() => setPicked(all ? new Set() : new Set(users.map((u) => u.username)))} />
            <span>全部学员（{users.length} 人）</span>
          </label>
          <div className="choice-grid">
            {users.map((u) => (
              <label key={u.id} className={`choice${picked.has(u.username) ? ' picked' : ''}`}>
                <input type="checkbox" checked={picked.has(u.username)} onChange={() => toggle(u.username)} />
                <span>{u.username}</span>
              </label>
            ))}
          </div>
          <div className="field" style={{ marginTop: 12 }}>
            <label htmlFor="gd-exp">到期日（不填 = 长期）</label>
            <input id="gd-exp" type="date" className="input" value={untilDay} onChange={(e) => setUntilDay(e.target.value)} />
          </div>
          <label className="choice">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} data-testid="auto-grant" />
            <span>以后新建的学员也自动开通这门课</span>
          </label>
          <div className="sticky-actions">
            <button className="btn" onClick={go} disabled={busy || (!picked.size && auto === subject.autoGrantNewUsers)} data-testid="grant-go">
              {busy ? '开通中…' : `开通 ${picked.size} 人`}
            </button>
            <button className="btn ghost" onClick={onClose} disabled={busy}>取消</button>
          </div>
        </>
      )}
    </div>
  );
}
