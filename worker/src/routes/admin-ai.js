import { Hono } from 'hono';
import { encryptSecret, decryptSecret, maskSecret } from '../lib/crypto.js';
import { chat, ocrImage, loadAISettings } from '../lib/ai.js';

export const aiRouter = new Hono();

const PURPOSES = ['PARSING', 'TUTORING'];

// 读取两套配置（Key 一律脱敏，明文永不下发）
aiRouter.get('/settings', async (c) => {
  const out = {};
  for (const purpose of PURPOSES) {
    const row = await c.env.DB.prepare('SELECT * FROM ai_settings WHERE purpose = ?')
      .bind(purpose).first();
    if (!row) {
      out[purpose] = null;
      continue;
    }
    const key = await decryptSecret(row.api_key_encrypted, c.env.ENCRYPTION_KEY);
    out[purpose] = {
      purpose,
      baseUrl: row.base_url,
      model: row.model,
      protocol: row.protocol,
      visionCapable: Boolean(row.vision_capable),
      apiKeyMasked: maskSecret(key),
      hasKey: Boolean(key),
      updatedAt: row.updated_at,
    };
  }
  return c.json({ settings: out });
});

// 保存一套配置。apiKey 留空表示"保持原有 Key 不变"
aiRouter.put('/settings/:purpose', async (c) => {
  const purpose = c.req.param('purpose');
  if (!PURPOSES.includes(purpose)) return c.json({ error: 'invalid_purpose' }, 400);
  if (!c.env.ENCRYPTION_KEY) return c.json({ error: 'encryption_key_missing' }, 500);

  const body = await c.req.json().catch(() => ({}));
  const existing = await c.env.DB.prepare('SELECT * FROM ai_settings WHERE purpose = ?')
    .bind(purpose).first();

  let encrypted = existing?.api_key_encrypted || null;
  if (body.apiKey) {
    encrypted = await encryptSecret(body.apiKey, c.env.ENCRYPTION_KEY);
  }

  const baseUrl = body.baseUrl ?? existing?.base_url ?? null;
  const model = body.model ?? existing?.model ?? null;
  const protocol = body.protocol ?? existing?.protocol ?? 'openai';
  const vision = body.visionCapable !== undefined
    ? (body.visionCapable ? 1 : 0)
    : (existing?.vision_capable ?? 0);

  await c.env.DB.prepare(
    `INSERT INTO ai_settings (purpose, base_url, api_key_encrypted, model, protocol, vision_capable, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(purpose) DO UPDATE SET
       base_url = excluded.base_url, api_key_encrypted = excluded.api_key_encrypted,
       model = excluded.model, protocol = excluded.protocol,
       vision_capable = excluded.vision_capable, updated_at = excluded.updated_at`
  ).bind(purpose, baseUrl, encrypted, model, protocol, vision).run();

  return c.json({ ok: true });
});

// 连通性测试：文本能力必测；解析 AI 额外测图片理解
aiRouter.post('/settings/:purpose/test', async (c) => {
  const purpose = c.req.param('purpose');
  if (!PURPOSES.includes(purpose)) return c.json({ error: 'invalid_purpose' }, 400);

  const cfg = await loadAISettings(c.env, purpose);
  if (!cfg?.base_url || !cfg?.apiKey) {
    return c.json({ ok: false, error: 'not_configured', message: '该配置尚未填写完整' }, 422);
  }

  const result = { purpose, model: cfg.model };
  try {
    const started = Date.now();
    const { content } = await chat(c.env, {
      purpose,
      feature: 'connectivity_test',
      settings: cfg,
      maxTokens: 64,
      messages: [{ role: 'user', content: '回复两个字：正常' }],
    });
    result.text = { ok: true, latencyMs: Date.now() - started, sample: content.slice(0, 80) };
  } catch (e) {
    result.text = { ok: false, error: e.code || String(e) };
  }

  if (purpose === 'PARSING') {
    // 一张 1x1 白色 PNG，只验证接口是否接受图片输入
    const tinyPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    try {
      const started = Date.now();
      const { content } = await ocrImage(c.env, {
        settings: cfg,
        imageDataUrl: tinyPng,
        prompt: '这张图片里有文字吗？只回答“有”或“无”。',
      });
      result.vision = { ok: true, latencyMs: Date.now() - started, sample: content.slice(0, 80) };
    } catch (e) {
      result.vision = { ok: false, error: e.code || String(e) };
    }
  }

  const ok = result.text?.ok && (purpose !== 'PARSING' || result.vision?.ok);
  return c.json({ ok, result });
});

// 用量统计：按用途与功能分组
aiRouter.get('/usage', async (c) => {
  const { results: byPurpose } = await c.env.DB.prepare(
    `SELECT purpose,
            COUNT(*) AS calls,
            SUM(success) AS ok_calls,
            SUM(tokens_in) AS tokens_in,
            SUM(tokens_out) AS tokens_out,
            CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms
     FROM ai_usage_logs
     WHERE created_at >= datetime('now', '-30 days')
     GROUP BY purpose`
  ).all();

  const { results: byFeature } = await c.env.DB.prepare(
    `SELECT purpose, feature, COUNT(*) AS calls, SUM(tokens_in + tokens_out) AS tokens
     FROM ai_usage_logs
     WHERE created_at >= datetime('now', '-30 days')
     GROUP BY purpose, feature ORDER BY calls DESC`
  ).all();

  const { results: recentErrors } = await c.env.DB.prepare(
    `SELECT purpose, feature, error_message, created_at FROM ai_usage_logs
     WHERE success = 0 ORDER BY id DESC LIMIT 10`
  ).all();

  return c.json({ byPurpose, byFeature, recentErrors });
});
