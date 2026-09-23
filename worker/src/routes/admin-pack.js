// 后台：学科能力包的查看与修改。挂在 /api/admin 下，鉴权与角色校验由 admin 路由组统一挂。
//
// 需求文档 §14.2 F1 要求"配置能力包全程在界面完成"。没有这一层的话，加一个学科
// 要手写 SQL——而手写 SQL 改判分标准这件事，出错了不会有任何地方报错。
import { Hono } from 'hono';
import { NORMALIZERS } from '../normalizers/index.js';
import { STRATEGY_INFO, ANSWER_SHAPES, GRADERS } from '../graders/index.js';
import { validateRubricPayload, settingInt } from '../lib/subject-pack.js';

export const adminPackRouter = new Hono();

const TYPE_CODE_RE = /^[a-z][a-z0-9_]{1,29}$/;
const FEATURES = ['essay_grade', 'wrong_analyze', 'answer_explain', 'assessment'];

async function loadSubject(db, id) {
  return db.prepare('SELECT subject_id, code, name FROM subjects WHERE subject_id = ?').bind(id).first();
}

// ---------------- 读 ----------------

adminPackRouter.get('/subjects/:id/pack', async (c) => {
  const id = Number(c.req.param('id'));
  const subject = await loadSubject(c.env.DB, id);
  if (!subject) return c.json({ error: 'not_found' }, 404);

  const [types, rubrics, prompts, schema, settings, globals] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT * FROM subject_question_types WHERE subject_id = ? ORDER BY sort_order, type_code').bind(id),
    c.env.DB.prepare('SELECT version, payload, is_current, created_at FROM subject_rubrics WHERE subject_id = ? ORDER BY version DESC').bind(id),
    // 学科自己的和全局兜底的一起返回，界面要能看出这条提示词是不是"继承来的"
    c.env.DB.prepare('SELECT subject_id, feature, system_prompt, user_template, updated_at FROM subject_ai_prompts WHERE subject_id IN (?, 0) ORDER BY feature, subject_id DESC').bind(id),
    c.env.DB.prepare('SELECT fields, updated_at FROM subject_explanation_schema WHERE subject_id = ?').bind(id),
    c.env.DB.prepare('SELECT key, value, description FROM subject_settings WHERE subject_id = ? ORDER BY key').bind(id),
    c.env.DB.prepare('SELECT key, value, description FROM system_settings ORDER BY key'),
  ]);

  const byFeature = new Map();
  for (const r of prompts.results) {
    // subject_id DESC 排序保证学科自己的排在全局前面，同一 feature 只留第一条
    if (!byFeature.has(r.feature)) byFeature.set(r.feature, { ...r, fromGlobal: r.subject_id === 0 });
  }

  const override = new Map(settings.results.map((r) => [r.key, r.value]));
  // effective 一定要走 settingInt 本身，不能在这儿另写一遍合并逻辑。
  // 两处各写一份的话，界面显示的"生效值"和运行时真正取到的值可能不一样，
  // 而这种不一样不会报错——界面说覆盖生效了，跑起来用的还是全局值。
  const effective = {};
  for (const g of globals.results) effective[g.key] = await settingInt(c.env.DB, id, g.key);

  return c.json({
    subject,
    questionTypes: types.results,
    rubrics: rubrics.results,
    currentRubric: rubrics.results.find((r) => r.is_current) || null,
    prompts: FEATURES.map((f) => byFeature.get(f) || { feature: f, missing: true }),
    explanationSchema: schema.results[0] || null,
    // 参数合并成一张表：全局默认 + 本学科覆盖，界面直接显示"现在生效的是哪个值"
    settings: globals.results.map((g) => ({
      key: g.key,
      description: g.description,
      globalValue: g.value,
      subjectValue: override.has(g.key) ? override.get(g.key) : null,
      effective: String(effective[g.key]),
    })),
    availableNormalizers: Object.keys(NORMALIZERS),
    // 界面不要自己抄一份策略清单：抄一份就会和注册表分叉，表现为"界面上有这个策略，
    // 保存之后判分说不认识"。
    availableStrategies: STRATEGY_INFO,
    availableShapes: ANSWER_SHAPES,
  });
});

// ---------------- 题型 ----------------

// 完整集合语义：没列进来的题型会被删掉。和授权界面一致——界面提交的本来就是全集。
adminPackRouter.put('/subjects/:id/pack/types', async (c) => {
  const id = Number(c.req.param('id'));
  const subject = await loadSubject(c.env.DB, id);
  if (!subject) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  const list = Array.isArray(body.questionTypes) ? body.questionTypes : null;
  if (!list) return c.json({ error: 'invalid_request', message: 'questionTypes 必须是数组' }, 400);
  if (!list.length) {
    // 一种题型都没有的学科，判分时会抛 subject_pack_missing，练习抽不出题。
    // 允许清空的话，管理员点一下保存就把学科弄瘫了，而当时什么提示都没有。
    return c.json({ error: 'empty_types', message: '至少要声明一种题型，否则这个学科没法判分也没法练习' }, 400);
  }

  const problems = [];
  const seen = new Set();
  for (const t of list) {
    const code = String(t.typeCode || '');
    if (!TYPE_CODE_RE.test(code)) { problems.push(`题型码 ${JSON.stringify(code)} 不合法（小写字母开头，可含数字下划线，2–30 位）`); continue; }
    if (seen.has(code)) { problems.push(`题型码 ${code} 重复`); continue; }
    seen.add(code);
    if (!String(t.name || '').trim()) problems.push(`题型 ${code} 没填名称`);
    // 判分策略与作答形态是题型的两个维度（§6.4.4），少一个这个题型就判不了分。
    // 写入时严查：读取时才发现的话，整个学科会因为一行配置而用不了。
    const g = GRADERS[String(t.gradingStrategy || '')];
    if (!g) {
      problems.push(`题型 ${code} 的判分策略 ${JSON.stringify(t.gradingStrategy)} 不在注册表里` +
        `（可选 ${Object.keys(GRADERS).join('、')}）`);
    } else if (g.needsAi !== !!t.needsAi) {
      // 勾了"需要 AI"却选了规则策略，交卷时的"待批改"计数会和实际判分对不上
      problems.push(`题型 ${code} 的"需要 AI 判分"与策略 ${g.strategy} 不一致：` +
        `该策略${g.needsAi ? '要' : '不要'} AI`);
    }
    if (!ANSWER_SHAPES.includes(String(t.answerShape || ''))) {
      problems.push(`题型 ${code} 的作答形态 ${JSON.stringify(t.answerShape)} 不合法` +
        `（可选 ${ANSWER_SHAPES.join('、')}）`);
    }
    for (const n of (Array.isArray(t.normalizers) ? t.normalizers : [])) {
      // 写错名字不能静默跳过：跳过的后果是判分悄悄少折一层等价，
      // 表现为"某些对的答案被判错"，而没有任何地方会报错。
      if (!NORMALIZERS[n]) problems.push(`题型 ${code} 引用了不存在的归一化器 ${JSON.stringify(n)}`);
    }
  }
  if (problems.length) return c.json({ error: 'invalid_types', problems }, 400);

  const stmts = [c.env.DB.prepare('DELETE FROM subject_question_types WHERE subject_id = ?').bind(id)];
  list.forEach((t, i) => {
    stmts.push(c.env.DB.prepare(
      `INSERT INTO subject_question_types
         (subject_id, type_code, name, is_objective, in_practice, needs_ai,
          input_widget, ai_review_on_miss, normalizers, sort_order,
          answer_shape, grading_strategy)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, String(t.typeCode), String(t.name), t.isObjective ? 1 : 0,
           t.inPractice ? 1 : 0, t.needsAi ? 1 : 0,
           String(t.inputWidget || 'text'), t.aiReviewOnMiss ? 1 : 0,
           JSON.stringify(Array.isArray(t.normalizers) ? t.normalizers : []), i + 1,
           String(t.answerShape), String(t.gradingStrategy)));
  });
  // 先删后插放在一个 batch 里：分两次的话中间那一刻学科是没有题型的，
  // 正在交卷的人会撞上 subject_pack_missing。
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, count: list.length });
});

// ---------------- 评价标准 ----------------

// 改标准是**新开一版**，不是原地改。历史报告要能按当次的标准重算（§14.2 F9），
// 原地改的话昨天那份 85 分今天就变成 78 分了，而没有任何地方记录发生过什么。
adminPackRouter.put('/subjects/:id/pack/rubric', async (c) => {
  const me = c.get('user');
  const id = Number(c.req.param('id'));
  const subject = await loadSubject(c.env.DB, id);
  if (!subject) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => ({}));
  let payload = body.payload;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); }
    catch { return c.json({ error: 'invalid_json', message: '评价标准不是合法 JSON' }, 400); }
  }
  if (!payload || typeof payload !== 'object') {
    return c.json({ error: 'invalid_request', message: '缺少 payload' }, 400);
  }
  const problems = validateRubricPayload(payload);
  if (problems.length) return c.json({ error: 'invalid_rubric', problems }, 400);

  const top = await c.env.DB.prepare('SELECT MAX(version) AS v FROM subject_rubrics WHERE subject_id = ?')
    .bind(id).first();
  const next = Number(top?.v || 0) + 1;
  await c.env.DB.batch([
    c.env.DB.prepare('UPDATE subject_rubrics SET is_current = 0 WHERE subject_id = ?').bind(id),
    c.env.DB.prepare(
      'INSERT INTO subject_rubrics (subject_id, version, payload, is_current, created_by) VALUES (?, ?, ?, 1, ?)'
    ).bind(id, next, JSON.stringify(payload), me.id),
  ]);
  return c.json({ ok: true, version: next });
});

// ---------------- 提示词 ----------------

adminPackRouter.put('/subjects/:id/pack/prompts/:feature', async (c) => {
  const id = Number(c.req.param('id'));
  const feature = c.req.param('feature');
  const subject = await loadSubject(c.env.DB, id);
  if (!subject) return c.json({ error: 'not_found' }, 404);
  if (!FEATURES.includes(feature)) {
    return c.json({ error: 'unknown_feature', message: `认不出的功能 ${feature}，只有 ${FEATURES.join('、')}` }, 400);
  }
  const body = await c.req.json().catch(() => ({}));
  const sys = String(body.systemPrompt || '').trim();
  const tpl = String(body.userTemplate || '').trim();
  if (!sys || !tpl) return c.json({ error: 'invalid_request', message: '系统提示词与用户模板都不能为空' }, 400);

  await c.env.DB.prepare(
    `INSERT INTO subject_ai_prompts (subject_id, feature, system_prompt, user_template, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(subject_id, feature) DO UPDATE SET
       system_prompt = excluded.system_prompt, user_template = excluded.user_template,
       updated_at = excluded.updated_at`
  ).bind(id, feature, sys, tpl).run();
  return c.json({ ok: true });
});

// 删掉学科自己的那条，回落到全局兜底
adminPackRouter.delete('/subjects/:id/pack/prompts/:feature', async (c) => {
  const id = Number(c.req.param('id'));
  const feature = c.req.param('feature');
  if (!FEATURES.includes(feature)) return c.json({ error: 'unknown_feature' }, 400);
  const global = await c.env.DB.prepare('SELECT 1 FROM subject_ai_prompts WHERE subject_id = 0 AND feature = ?')
    .bind(feature).first();
  if (!global) {
    // 没有兜底就删掉的话，这个功能会在下一次调用时抛 prompt_missing
    return c.json({ error: 'no_global_fallback', message: `全局没有 ${feature} 的兜底提示词，删掉之后这个功能会直接不可用` }, 409);
  }
  await c.env.DB.prepare('DELETE FROM subject_ai_prompts WHERE subject_id = ? AND feature = ?')
    .bind(id, feature).run();
  return c.json({ ok: true, fallsBackToGlobal: true });
});

// ---------------- 参数覆盖 ----------------

adminPackRouter.put('/subjects/:id/pack/settings', async (c) => {
  const id = Number(c.req.param('id'));
  const subject = await loadSubject(c.env.DB, id);
  if (!subject) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const entries = Array.isArray(body.settings) ? body.settings : null;
  if (!entries) return c.json({ error: 'invalid_request', message: 'settings 必须是数组' }, 400);

  const { results: known } = await c.env.DB.prepare('SELECT key FROM system_settings').all();
  const knownKeys = new Set(known.map((k) => k.key));
  const unknown = entries.map((e) => String(e.key)).filter((k) => !knownKeys.has(k));
  if (unknown.length) {
    // 覆盖一个不存在的参数不会报错，只会永远不生效——那是最难查的一类"配了但没用"
    return c.json({
      error: 'unknown_setting',
      message: `这些参数在全局里不存在，覆盖了也不会生效：${unknown.join('、')}`,
    }, 400);
  }

  const stmts = [c.env.DB.prepare('DELETE FROM subject_settings WHERE subject_id = ?').bind(id)];
  for (const e of entries) {
    // value 为空表示"不覆盖，用全局值"
    if (e.value === null || e.value === undefined || String(e.value).trim() === '') continue;
    stmts.push(c.env.DB.prepare(
      'INSERT INTO subject_settings (subject_id, key, value, description) VALUES (?, ?, ?, ?)'
    ).bind(id, String(e.key), String(e.value).trim(), e.description ?? null));
  }
  await c.env.DB.batch(stmts);
  return c.json({ ok: true, overrides: stmts.length - 1 });
});
