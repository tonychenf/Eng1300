// 后台「识别实测」（改进阶段 2 第二期，PRD 第 6 节）：管理员在页面上传几张真实照片（任何学科、任何资料）、
// 选几个读图模型和压缩尺寸，逐张识别。页面拿识别结果自己去仓库的人工转写稿里找对得上的那一页，对上了逐字算准确率；
// 对不上的把原图和各模型的结果并排给人看。出一份准确率 / 完整率 / 模型间一致 / 体检 / 耗时 / 花费的报告，用来挑模型。
// 照片不用标页码（用户 2026-11-10）：库里 ocr_bench_results.page 存的是"第几张照片"（从 1 起）。
//
// 三条规矩：
//   ① **图片不留**（用户 2026-11-07 定）：每张图只在 recognize 这一次请求里用，识别完就丢，库里只存识别出的文字；
//   ② 用「图片解析 AI」那一档的接口地址和 Key（已有的硅基流动 Key，不新增 Secret），只把模型换成要比的那个；
//   ③ 先预估再确认：建实测时页面带着预估花费，本月花费到了上限要明说"继续"（同出答案，lib/ai-budget.js）。
// 比对（编辑距离）在浏览器里算（理由见 lib/ocr-metrics.js），算完存回 metrics_json。
import { Hono } from 'hono';
import { resolveSettings, chat } from '../lib/ai.js';
import { budgetStatus } from '../lib/ai-budget.js';
import { auditStmt } from '../lib/audit.js';

export const ocrBenchRouter = new Hono();

const bad = (c, status, error, message, extra = {}) => c.json({ error, message, ...extra }, status);
const SIZES = [1600, 2400];
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;     // 压缩后的 JPEG，长边 2400 也就一两兆
const OCR_TIMEOUT_MS = 90000;                 // 读图模型一页十几秒到几十秒，留够

export const OCR_PROMPT = [
  '请把这张图片里的文字完整、逐字识别出来，按原来的换行输出纯文本。',
  '- 题号、选项字母照原样写出；',
  '- 页眉页脚的页码也写出来；',
  '- 表格按行写，同一行的格子之间用空格隔开；公式照原样写（可以用 LaTeX）；',
  '- 看不清的字写 □，不要猜，不要补全，也不要改正原文里的错；',
  '- 不要加任何解释，不要用 Markdown。',
].join('\n');

async function parsingSettings(env) {
  return resolveSettings(env, 'PARSING');
}

// 页面要的东西：现在「图片解析 AI」配的是什么、服务商那边有哪些模型可选、本月花费
ocrBenchRouter.get('/config', async (c) => {
  const cfg = await parsingSettings(c.env);
  const budget = await budgetStatus(c.env.DB);
  if (!cfg) return c.json({ provider: null, models: [], modelsError: '「图片解析 AI」还没配，先到 AI 配置页配好接口地址和 Key', budget });
  let models = [];
  let modelsError = null;
  try {
    const r = await fetch(`${cfg.base_url.replace(/\/+$/, '')}/models`, { headers: { Authorization: `Bearer ${cfg.apiKey}` } });
    const j = await r.json();
    models = Array.isArray(j?.data) ? j.data.map((m) => String(m.id)).filter(Boolean) : [];
    if (!r.ok || !models.length) modelsError = `服务商没列出模型（HTTP ${r.status}），可以手动填模型名`;
  } catch (e) {
    modelsError = `取不到服务商的模型清单（${String(e.message || e).slice(0, 80)}），可以手动填模型名`;
  }
  let host = null;
  try { host = new URL(cfg.base_url).host; } catch { host = null; }
  return c.json({
    provider: { host, model: cfg.model, priceInPerM: cfg.price_in_per_m ?? null, priceOutPerM: cfg.price_out_per_m ?? null, usedPurpose: cfg._usedPurpose },
    models, modelsError, budget, sizes: SIZES,
  });
});

// 新的在前；created_at 只到秒，同一秒建的几次按插入先后（rowid）排，后建的在前
ocrBenchRouter.get('/', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT r.id, r.config_json, r.created_at,
            (SELECT COUNT(*) FROM ocr_bench_results x WHERE x.bench_id = r.id) AS results,
            (SELECT SUM(cost_yuan) FROM ocr_bench_results x WHERE x.bench_id = r.id) AS cost
       FROM ocr_bench_runs r ORDER BY r.created_at DESC, r.rowid DESC LIMIT 50`
  ).all();
  return c.json({ runs: results.map((r) => ({ id: r.id, createdAt: r.created_at, results: r.results, cost: r.cost, config: JSON.parse(r.config_json) })) });
});

// 建一次实测（页面已经显示过预估、管理员点了"开始"）
ocrBenchRouter.post('/', async (c) => {
  const me = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  // 照片只记文件名（报告里认得出是哪张），不用标页码
  const raw = Array.isArray(body.photos) ? body.photos : [];
  if (!raw.length || raw.length > 10) return bad(c, 400, 'invalid_photos', '要测 1–10 张照片');
  const photos = raw.map((p, i) => ({ no: i + 1, name: String(p?.name ?? '').trim().slice(0, 120) || `照片 ${i + 1}` }));
  const models = Array.isArray(body.models) ? body.models : [];
  if (!models.length || models.length > 5) return bad(c, 400, 'invalid_models', '选 1–5 个模型');
  const clean = [];
  for (const m of models) {
    const id = String(m?.id ?? '').trim();
    if (!id || id.length > 120) return bad(c, 400, 'invalid_models', '模型名不能为空');
    const price = (v) => (v === undefined || v === null || v === '' ? null : Number(v));
    const pin = price(m.priceInPerM);
    const pout = price(m.priceOutPerM);
    if ((pin !== null && !(pin >= 0)) || (pout !== null && !(pout >= 0))) return bad(c, 400, 'invalid_price', `模型 ${id} 的单价要是不小于 0 的数`);
    clean.push({ id, priceInPerM: pin, priceOutPerM: pout });
  }
  const sizes = Array.isArray(body.sizes) ? [...new Set(body.sizes.map(Number))] : [];
  if (!sizes.length || sizes.some((s) => !SIZES.includes(s))) return bad(c, 400, 'invalid_sizes', `压缩尺寸只能选 ${SIZES.join(' / ')}`);
  if (!(await parsingSettings(c.env))) return bad(c, 422, 'ai_not_configured', '「图片解析 AI」还没配，先到 AI 配置页配好');

  const budget = await budgetStatus(c.env.DB);
  if (budget.over && body.confirmOverBudget !== true) {
    return bad(c, 409, 'over_budget', `本月 AI 花费已到上限（已花 ${budget.spent} 元 / 上限 ${budget.budget} 元），确认继续才会接着花`, { budget });
  }
  const id = `ocr-${crypto.randomUUID()}`;
  const config = { photos, models: clean, sizes, estimateYuan: Number.isFinite(Number(body.estimateYuan)) ? Number(body.estimateYuan) : null };
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO ocr_bench_runs (id, created_by, config_json) VALUES (?, ?, ?)').bind(id, me.id, JSON.stringify(config)),
    auditStmt(c.env.DB, { actorId: me.id, action: budget.over ? 'ocr_bench.create_over_budget' : 'ocr_bench.create', target: id, after: config }),
  ]);
  return c.json({ id, config }, 201);
});

async function loadRun(db, id) {
  const r = await db.prepare('SELECT * FROM ocr_bench_runs WHERE id = ?').bind(id).first();
  return r ? { ...r, config: JSON.parse(r.config_json) } : null;
}

// 识别一张。图片只在这一次请求里：识别完就丢，库里只存文字
ocrBenchRouter.post('/:id/recognize', async (c) => {
  const run = await loadRun(c.env.DB, c.req.param('id'));
  if (!run) return bad(c, 404, 'not_found', '没有这次实测');
  const body = await c.req.json().catch(() => ({}));
  const photo = Number(body.photo);
  const size = Number(body.size);
  const model = run.config.models.find((m) => m.id === String(body.model ?? ''));
  if (!(run.config.photos || []).some((p) => p.no === photo)) return bad(c, 400, 'invalid_photo', `这次实测没有第 ${body.photo} 张照片`);
  if (!run.config.sizes.includes(size)) return bad(c, 400, 'invalid_size', `这次实测没有选 ${body.size} 这个尺寸`);
  if (!model) return bad(c, 400, 'invalid_model', `这次实测没有选模型 ${body.model}`);
  const image = String(body.image ?? '');
  const m = image.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return bad(c, 400, 'invalid_image', '图片要是浏览器压缩好的 data:image/jpeg;base64,… ');
  if (m[2].length * 0.75 > MAX_IMAGE_BYTES) return bad(c, 413, 'image_too_large', `压缩后的图片超过 ${MAX_IMAGE_BYTES / 1048576}MB`);

  const cfg = await parsingSettings(c.env);
  if (!cfg) return bad(c, 422, 'ai_not_configured', '「图片解析 AI」还没配');
  // 同一个服务商、同一个 Key，只换模型；单价用实测里填的，没填而模型正好是现配的那个，就用配置里的单价
  const same = model.id === cfg.model;
  const settings = {
    ...cfg, model: model.id,
    price_in_per_m: model.priceInPerM ?? (same ? cfg.price_in_per_m : null),
    price_out_per_m: model.priceOutPerM ?? (same ? cfg.price_out_per_m : null),
  };
  let text = null, usage = null, latencyMs = null, error = null;
  const started = Date.now();
  try {
    const r = await chat(c.env, {
      purpose: 'PARSING', feature: 'ocr_bench', settings, maxTokens: 4000, timeoutMs: OCR_TIMEOUT_MS,
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: image } }, { type: 'text', text: OCR_PROMPT }] }],
    });
    text = r.content;
    usage = r.usage;
    latencyMs = r.latencyMs;
  } catch (e) {
    // 服务商回的错（模型名不对、不支持图片……）原样留一段，报告里看得出是哪种失败
    error = `${e.code || 'ai_failed'}${e.detail ? `：${JSON.stringify(e.detail).slice(0, 200)}` : ''}`;
    latencyMs = Date.now() - started;
  }
  const pin = settings.price_in_per_m;
  const pout = settings.price_out_per_m;
  const cost = usage && pin != null && pout != null
    ? Math.round(((Number(usage.prompt_tokens || 0) * pin + Number(usage.completion_tokens || 0) * pout) / 1e6) * 1e6) / 1e6
    : null;
  const res = await c.env.DB.prepare(
    `INSERT INTO ocr_bench_results (bench_id, page, model, size, text, latency_ms, tokens_in, tokens_out, cost_yuan, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(run.id, photo, model.id, size, text, latencyMs, usage?.prompt_tokens ?? null, usage?.completion_tokens ?? null, cost, error).run();
  return c.json({
    resultId: res.meta.last_row_id, photo, model: model.id, size, text, latencyMs,
    tokensIn: usage?.prompt_tokens ?? null, tokensOut: usage?.completion_tokens ?? null, cost, error,
  });
});

// 页面算好的指标存回来
ocrBenchRouter.put('/:id/results/:rid/metrics', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const json = JSON.stringify(body.metrics ?? null);
  if (!body.metrics || typeof body.metrics !== 'object') return bad(c, 400, 'invalid_metrics', '缺少 metrics');
  if (json.length > 40000) return bad(c, 413, 'metrics_too_large', '指标太大了');
  const r = await c.env.DB.prepare('UPDATE ocr_bench_results SET metrics_json = ? WHERE id = ? AND bench_id = ?')
    .bind(json, Number(c.req.param('rid')), c.req.param('id')).run();
  if (!r.meta.changes) return bad(c, 404, 'not_found', '没有这条识别结果');
  return c.json({ ok: true });
});

ocrBenchRouter.get('/:id', async (c) => {
  const run = await loadRun(c.env.DB, c.req.param('id'));
  if (!run) return bad(c, 404, 'not_found', '没有这次实测');
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM ocr_bench_results WHERE bench_id = ? ORDER BY page, model, size, id'
  ).bind(run.id).all();
  return c.json({
    id: run.id, createdAt: run.created_at, config: run.config,
    results: results.map((r) => ({
      // 以前（2026-11-09 那一版）标页码的实测，page 是原书页码；之后的是第几张照片
      id: r.id, ...(run.config.photos ? { photo: r.page } : { page: r.page }), model: r.model, size: r.size, text: r.text, latencyMs: r.latency_ms,
      tokensIn: r.tokens_in, tokensOut: r.tokens_out, cost: r.cost_yuan, error: r.error,
      metrics: r.metrics_json ? JSON.parse(r.metrics_json) : null,
    })),
  });
});
