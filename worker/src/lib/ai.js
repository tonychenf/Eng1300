// AI 调用封装（PRD §10）。
//
// 关键约束（实测得出，见 PRD §10.0）：Qwen3-8B 是推理模型，不显式关闭思考模式时
// 约 2/3 的结构化请求会把 token 全部消耗在内部推理上、返回空对象，延迟也从 3 秒
// 涨到 15 秒以上。因此这里对所有教学类调用强制带 enable_thinking: false。

import { purposeChain } from './ai-purposes.js';
import { decryptSecret } from './crypto.js';

const DEFAULT_MAX_TOKENS = 2000;

/**
 * 取某用途的 AI 配置。
 *
 * N3 起这张表按 (purpose, subject_id) 存，subject_id = 0 是全局兜底。
 * 传 subjectId 时先找该学科的覆盖，没有就回落到全局——学科可以自己指定模型，
 * 不指定就跟着平台走。ORDER BY subject_id DESC 让覆盖排在兜底前面。
 */
export async function loadAISettings(env, purpose, subjectId = 0) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM ai_settings WHERE purpose = ? AND subject_id IN (?, 0)
      ORDER BY subject_id DESC LIMIT 1`
  ).bind(purpose, subjectId || 0).all();
  const row = results[0];
  if (!row) return null;
  const apiKey = await decryptSecret(row.api_key_encrypted, env.ENCRYPTION_KEY);
  return { ...row, apiKey };
}

/**
 * 按回落链取配置：自己没配就往下找（链在 lib/ai-purposes.js）。
 *
 * **回落必须说得出来。** 返回里带上 `_usedPurpose`：管理员在「文字解析 AI」那栏
 * 什么都没填时，实际跑的是图片解析那档——不报出来的话，他会以为自己配的模型在跑，
 * 而账单、时延、效果全来自另一个模型，三者都对不上又找不到原因。
 * `_fallback` 保留给既有调用方，语义不变（用的不是自己那一档）。
 */
export async function resolveSettings(env, purpose, subjectId = 0) {
  for (const code of purposeChain(purpose)) {
    const cfg = await loadAISettings(env, code, subjectId);
    if (cfg?.base_url && cfg?.apiKey) {
      return { ...cfg, _usedPurpose: code, _fallback: code !== purpose };
    }
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

// 有并发上限地并行跑一批任务。
//
// 起因：交卷后那次 AI 处理要批改作文再逐条分析错题，原本是串行的。本地替身
// 瞬间返回，看不出问题；接到真实服务商上，一次调用 3-4 秒、错题最多 20 条，
// 整个请求就要 80 秒以上——线上实测客户端 60 秒超时拿不到任何返回，而服务端
// 那边已经默默分析了十几条。学员在成绩报告页点一下按钮，等到的就是这个。
//
// 上限取 5：20 条分四批约 15 秒，既压住总时长，也不至于把供应商的速率限制打爆。
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
