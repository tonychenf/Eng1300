import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { get, put, api } from '../../api.js';
import { Alert, Loading, PageHead } from '../../components/ui.jsx';

// 学科能力包：题型、评价标准、AI 提示词、参数覆盖。
//
// 这些东西在蓝本里是写死在代码里的英语规则。搬进数据之后必须有地方能改，
// 否则加一个学科还是要改代码——只是从改 grade.js 变成了手写 SQL，
// 而手写 SQL 改判分标准出错了不会有任何地方报错。
const WIDGETS = [
  { value: 'choice', label: '选项（单选）' },
  { value: 'text', label: '单行文本' },
  { value: 'textarea', label: '多行文本' },
];
const FEATURE_LABELS = {
  essay_grade: '主观题批改',
  wrong_analyze: '错题分析',
  answer_explain: '答案解读',
  assessment: '能力评估',
};

function TypeRow({ t, all, onChange, onRemove }) {
  const set = (patch) => onChange({ ...t, ...patch });
  return (
    <div className="card card-pad" style={{ marginBottom: 8 }}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 8 }}>
        <label className="small" style={{ flex: '1 1 150px' }}>
          题型码
          <input value={t.typeCode} onChange={(e) => set({ typeCode: e.target.value })}
                 placeholder="如 fill_blank" />
        </label>
        <label className="small" style={{ flex: '1 1 150px' }}>
          名称
          <input value={t.name} onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="small" style={{ flex: '1 1 150px' }}>
          作答控件
          <select value={t.inputWidget} onChange={(e) => set({ inputWidget: e.target.value })}>
            {WIDGETS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
          </select>
        </label>
      </div>
      <div className="row" style={{ flexWrap: 'wrap', gap: 12, marginTop: 8 }}>
        <label className="tiny"><input type="checkbox" checked={t.isObjective}
          onChange={(e) => set({ isObjective: e.target.checked })} /> 规则可判</label>
        <label className="tiny"><input type="checkbox" checked={t.inPractice}
          onChange={(e) => set({ inPractice: e.target.checked })} /> 进专项练习</label>
        <label className="tiny"><input type="checkbox" checked={t.needsAi}
          onChange={(e) => set({ needsAi: e.target.checked })} /> 需要 AI 判分</label>
        <label className="tiny"><input type="checkbox" checked={t.aiReviewOnMiss}
          onChange={(e) => set({ aiReviewOnMiss: e.target.checked })} /> 判错后交 AI 复核</label>
      </div>
      <div className="tiny" style={{ marginTop: 8 }}>
        归一化器（什么算"等价"）：
        {all.map((n) => (
          <label key={n} style={{ marginLeft: 10 }}>
            <input
              type="checkbox"
              checked={t.normalizers.includes(n)}
              onChange={(e) => set({
                normalizers: e.target.checked
                  ? [...t.normalizers, n]
                  : t.normalizers.filter((x) => x !== n),
              })}
            /> {n}
          </label>
        ))}
      </div>
      <div style={{ marginTop: 8 }}>
        <button className="btn ghost sm" type="button" onClick={onRemove}>删掉这一行</button>
      </div>
    </div>
  );
}

export default function SubjectPack() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [types, setTypes] = useState([]);
  const [rubricText, setRubricText] = useState('');
  const [promptDraft, setPromptDraft] = useState({});
  const [overrides, setOverrides] = useState({});
  const [error, setError] = useState('');
  const [problems, setProblems] = useState([]);
  const [msg, setMsg] = useState('');

  const load = () => get(`/admin/subjects/${id}/pack`).then((r) => {
    setData(r);
    setTypes(r.questionTypes.map((t) => ({
      typeCode: t.type_code, name: t.name,
      isObjective: !!t.is_objective, inPractice: !!t.in_practice,
      needsAi: !!t.needs_ai, aiReviewOnMiss: !!t.ai_review_on_miss,
      inputWidget: t.input_widget,
      normalizers: JSON.parse(t.normalizers || '[]'),
    })));
    setRubricText(r.currentRubric ? JSON.stringify(JSON.parse(r.currentRubric.payload), null, 2) : '');
    setPromptDraft(Object.fromEntries(r.prompts.map((p) => [p.feature, {
      systemPrompt: p.system_prompt || '', userTemplate: p.user_template || '',
    }])));
    setOverrides(Object.fromEntries(r.settings.map((s) => [s.key, s.subjectValue ?? ''])));
  }).catch((e) => setError(e.message));
  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [id]);

  async function run(fn, okMsg) {
    setError(''); setProblems([]); setMsg('');
    try { await fn(); setMsg(okMsg); await load(); }
    catch (e) {
      setError(e.message);
      // 后端把"哪几条不合格"逐条列出来了，别只显示一句"保存失败"
      if (Array.isArray(e.payload?.problems)) setProblems(e.payload.problems);
    }
  }

  if (!data) return error ? <Alert>{error}</Alert> : <Loading />;

  return (
    <>
      <PageHead
        title={`能力包 · ${data.subject.name}`}
        desc="题型、评价标准、AI 提示词、参数覆盖。蓝本里这些是写死的英语规则，现在按学科配置。"
      />
      <p className="small">
        <Link to="/admin/subjects">← 回学科管理</Link>
      </p>
      {error ? <Alert>{error}</Alert> : null}
      {problems.length ? (
        <Alert>
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {problems.map((p, i) => <li key={i} className="small">{p}</li>)}
          </ul>
        </Alert>
      ) : null}
      {msg ? <Alert kind="success">{msg}</Alert> : null}

      <section style={{ marginTop: 16 }}>
        <h2 style={{ fontSize: 16 }}>题型</h2>
        <p className="tiny faint" style={{ marginTop: 0 }}>
          提交的是完整清单：没列进来的题型会被删掉。已有题目用着的题型别删——
          删了之后那些题在判分时会直接报错。
        </p>
        {types.map((t, i) => (
          <TypeRow
            key={i} t={t} all={data.availableNormalizers}
            onChange={(nt) => setTypes(types.map((x, j) => (j === i ? nt : x)))}
            onRemove={() => setTypes(types.filter((_, j) => j !== i))}
          />
        ))}
        <div className="row">
          <button className="btn ghost sm" type="button" onClick={() => setTypes([...types, {
            typeCode: '', name: '', isObjective: true, inPractice: true,
            needsAi: false, aiReviewOnMiss: false, inputWidget: 'text', normalizers: [],
          }])}>加一个题型</button>
          <button className="btn sm" type="button"
            onClick={() => run(() => put(`/admin/subjects/${id}/pack/types`, { questionTypes: types }), '题型已保存')}>
            保存题型
          </button>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16 }}>评价标准</h2>
        <p className="tiny faint" style={{ marginTop: 0 }}>
          当前第 {data.currentRubric?.version ?? '—'} 版。保存会**新开一版**而不是原地改：
          历史报告要能按当次的标准重算，原地改的话昨天那份 85 分今天就变成 78 分了。
        </p>
        <textarea
          value={rubricText} onChange={(e) => setRubricText(e.target.value)}
          rows={18} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn sm" type="button"
            onClick={() => run(() => put(`/admin/subjects/${id}/pack/rubric`, { payload: rubricText }), '评价标准已存为新版本')}>
            存为新版本
          </button>
          <span className="tiny faint">历史版本：{data.rubrics.map((r) => `v${r.version}`).join('、') || '无'}</span>
        </div>
      </section>

      <section style={{ marginTop: 24 }}>
        <h2 style={{ fontSize: 16 }}>AI 提示词</h2>
        {data.prompts.map((p) => (
          <div className="card card-pad" key={p.feature} style={{ marginBottom: 8 }}>
            <div className="spread">
              <strong className="small">{FEATURE_LABELS[p.feature] || p.feature}</strong>
              <span className={`badge${p.fromGlobal ? '' : ' info'}`}>
                {p.missing ? '缺失' : p.fromGlobal ? '继承自全局' : '本学科'}
              </span>
            </div>
            <label className="small">系统提示词
              <input
                value={promptDraft[p.feature]?.systemPrompt || ''}
                onChange={(e) => setPromptDraft({
                  ...promptDraft,
                  [p.feature]: { ...promptDraft[p.feature], systemPrompt: e.target.value },
                })}
              />
            </label>
            <label className="small">用户模板（{'{{占位符}}'} 由程序填，缺一个会当场报错）
              <textarea
                rows={8} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12 }}
                value={promptDraft[p.feature]?.userTemplate || ''}
                onChange={(e) => setPromptDraft({
                  ...promptDraft,
                  [p.feature]: { ...promptDraft[p.feature], userTemplate: e.target.value },
                })}
              />
            </label>
            <div className="row">
              <button className="btn sm" type="button"
                onClick={() => run(() => put(`/admin/subjects/${id}/pack/prompts/${p.feature}`, promptDraft[p.feature]), '提示词已保存')}>
                保存
              </button>
              {!p.fromGlobal && !p.missing ? (
                <button className="btn ghost sm" type="button"
                  onClick={() => run(() => api(`/admin/subjects/${id}/pack/prompts/${p.feature}`, { method: 'DELETE' }), '已恢复为全局提示词')}>
                  恢复为全局
                </button>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      <section style={{ marginTop: 24, marginBottom: 32 }}>
        <h2 style={{ fontSize: 16 }}>参数覆盖</h2>
        <p className="tiny faint" style={{ marginTop: 0 }}>留空表示不覆盖、跟随全局值。</p>
        {data.settings.map((s) => (
          <label className="small" key={s.key} style={{ display: 'block', marginBottom: 10 }}>
            {s.key} <span className="tiny faint">（{s.description}；全局 {s.globalValue}）</span>
            <input
              value={overrides[s.key] ?? ''}
              placeholder={`跟随全局 ${s.globalValue}`}
              onChange={(e) => setOverrides({ ...overrides, [s.key]: e.target.value })}
            />
          </label>
        ))}
        <button className="btn sm" type="button"
          onClick={() => run(() => put(`/admin/subjects/${id}/pack/settings`, {
            settings: Object.entries(overrides).map(([key, value]) => ({ key, value })),
          }), '参数覆盖已保存')}>
          保存参数
        </button>
      </section>
    </>
  );
}
