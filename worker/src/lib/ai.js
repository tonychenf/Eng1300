// AI 调用封装（PRD §10）。
//
// 关键约束（实测得出，见 PRD §10.0）：Qwen3-8B 是推理模型，不显式关闭思考模式时
// 约 2/3 的结构化请求会把 token 全部消耗在内部推理上、返回空对象，延迟也从 3 秒
// 涨到 15 秒以上。因此这里对所有教学类调用强制带 enable_thinking: false。

import { decryptSecret } from './crypto.js';

const DEFAULT_MAX_TOKENS = 2000;

export async function loadAISettings(env, purpose) {
  const row = await env.DB.prepare('SELECT * FROM ai_settings WHERE purpose = ?').bind(purpose).first();
  if (!row) return null;
  const apiKey = await decryptSecret(row.api_key_encrypted, env.ENCRYPTION_KEY);
  return { ...row, apiKey };
}

// 教学 AI 未单独配置时回退到解析 AI 的配置（PRD §5.4）
export async function resolveSettings(env, purpose) {
  const primary = await loadAISettings(env, purpose);
  if (primary?.base_url && primary?.apiKey) return primary;
  if (purpose === 'TUTORING') {
    const fallback = await loadAISettings(env, 'PARSING');
    if (fallback?.base_url && fallback?.apiKey) return { ...fallback, _fallback: true };
  }
  return null;
}

async function logUsage(env, { purpose, feature, usage, latencyMs, success, errorMessage }) {
  try {
    await env.DB.prepare(
      `INSERT INTO ai_usage_logs (purpose, feature, tokens_in, tokens_out, latency_ms, success, error_message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        purpose,
        feature || null,
        usage?.prompt_tokens || 0,
        usage?.completion_tokens || 0,
        latencyMs || null,
        success ? 1 : 0,
        errorMessage || null
      )
      .run();
  } catch {
    // 记账失败不能影响主流程
  }
}

/**
 * 调用聊天补全。
 * @param {object} opts
 * @param {'PARSING'|'TUTORING'} opts.purpose
 * @param {string} opts.feature   用量归类，如 'answer_explain' / 'essay_grade'
 * @param {Array}  opts.messages
 * @param {boolean} opts.json     是否要求 JSON 输出
 * @param {number} opts.maxTokens
 */
export async function chat(env, opts) {
  const { purpose, feature, messages, json = false, maxTokens = DEFAULT_MAX_TOKENS, settings } = opts;
  const cfg = settings || (await resolveSettings(env, purpose));
  if (!cfg) {
    const err = new Error('ai_not_configured');
    err.code = 'ai_not_configured';
    throw err;
  }

  const body = {
    model: cfg.model,
    messages,
    max_tokens: maxTokens,
    // 强制关闭思考模式——不加会导致约2/3的空响应，且延迟涨到15秒以上
    enable_thinking: false,
  };
  if (json) body.response_format = { type: 'json_object' };

  const started = Date.now();
  let resp, data;
  try {
    resp = await fetch(`${cfg.base_url.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    data = await resp.json();
  } catch (e) {
    await logUsage(env, {
      purpose, feature, latencyMs: Date.now() - started, success: false, errorMessage: String(e),
    });
    const err = new Error('ai_unavailable');
    err.code = 'ai_unavailable';
    throw err;
  }

  const latencyMs = Date.now() - started;
  if (!resp.ok) {
    await logUsage(env, {
      purpose, feature, latencyMs, success: false,
      errorMessage: JSON.stringify(data).slice(0, 500),
    });
    const err = new Error('ai_error');
    err.code = 'ai_error';
    err.detail = data;
    throw err;
  }

  const content = data?.choices?.[0]?.message?.content ?? '';
  await logUsage(env, { purpose, feature, usage: data.usage, latencyMs, success: true });
  return { content, usage: data.usage, latencyMs };
}

/** 要求返回 JSON 的调用：解析失败自动重试一次（PRD §10.3） */
export async function chatJSON(env, opts) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content, usage, latencyMs } = await chat(env, { ...opts, json: true });
    try {
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
        return { data: parsed, usage, latencyMs };
      }
    } catch {
      // 落到下一次重试
    }
  }
  const err = new Error('ai_bad_json');
  err.code = 'ai_bad_json';
  throw err;
}

/** 视觉/OCR 调用：把图片交给解析 AI 取文字 */
export async function ocrImage(env, { imageDataUrl, prompt, settings }) {
  const cfg = settings || (await resolveSettings(env, 'PARSING'));
  if (!cfg) {
    const err = new Error('ai_not_configured');
    err.code = 'ai_not_configured';
    throw err;
  }
  return chat(env, {
    purpose: 'PARSING',
    feature: 'ocr',
    settings: cfg,
    maxTokens: 4000,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageDataUrl } },
          { type: 'text', text: prompt || '请完整识别这张图片中的所有文字，保持原有换行与结构。' },
        ],
      },
    ],
  });
}
