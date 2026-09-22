#!/usr/bin/env node
// 测试用的假 AI 服务：模仿 OpenAI Chat Completions 协议。
//
// 沙箱的出站策略拦掉了真实的 AI 服务商，而 M5 的作文批改、错题分析、能力评估
// 都要走这条链路。用一个本地替身把链路跑通，同时还能按需制造"返回非法 JSON"
// 和"服务不可用"两种失败，验证 PRD §10.3 的降级行为。
//
// 路由：
//   /v1/chat/completions      正常返回
//   /bad/v1/chat/completions  返回非法 JSON（验证重试后标记待重试）
//   /fail/v1/chat/completions 返回 500
import http from 'node:http';

const PORT = Number(process.argv[2] || 8899);

function reply(promptText) {
  if (promptText.includes('批改这篇自考英语作文')) {
    return JSON.stringify({
      content: 5, language: 4, vocabulary: 4.5, coherence: 5, length: 6,
      comments: {
        content: '要点覆盖完整。', language: '有几处时态问题。',
        vocabulary: '用词尚可。', coherence: '结构清楚。', length: '字数达标。',
      },
      suggestions: ['注意一般现在时', '多用连接词', '结尾再点题'],
    });
  }
  if (promptText.includes('分析学生这道题做错的原因')) {
    return JSON.stringify({
      errorReason: '把细节题当成了主旨题，定位到了错误段落。',
      memoryPoint: '细节题先回原文找关键词，再比对选项。',
    });
  }
  if (promptText.includes('给出能力评估')) {
    return JSON.stringify({
      predictedLow: 62, predictedHigh: 71,
      levelDesc: '接近及格线，阅读稳定，完形和写作是短板。',
      weakPoints: ['词汇辨析', '逻辑关系判断'],
      suggestions: ['每天背 20 个高频词', '完形填空专项练一周', '作文套用固定结构'],
    });
  }
  if (promptText.includes('给学生讲解这道题')) {
    return JSON.stringify({ explanation: '本题考查细节定位，原文第二段明确提到了该信息。' });
  }
  return JSON.stringify({ ok: true });
}

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (req.url.startsWith('/fail/')) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'stub failure' } }));
      return;
    }
    let promptText = '';
    try {
      const parsed = JSON.parse(body);
      promptText = (parsed.messages || []).map((m) =>
        typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n');
      // 顺带校验强制参数：漏了它线上会有约 2/3 的空响应（PRD §10.0）
      if (parsed.enable_thinking !== false) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'enable_thinking 必须显式设为 false' } }));
        return;
      }
    } catch { /* 保持空 */ }

    const content = req.url.startsWith('/bad/') ? '这不是 JSON，故意的' : reply(promptText);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`AI 替身已启动: http://127.0.0.1:${PORT}`));
