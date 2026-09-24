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
//   /wrongshape/v1/chat/completions  返回**合法 JSON 但形状不对**
//
// 最后那条是 N6b 加的，它测的东西和 /bad/ 不一样：/bad/ 是"解析不出来"，
// 而真实服务商更常见的失败是"回了一个像模像样的 JSON，字段数对不上题"。
// 前者会被 JSON.parse 挡住，后者只有形状校验挡得住——而形状校验没写对时，
// 表现是半个答案被写进库，看起来像"已经录过了"。
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
  // N6b：给上传进来的题生成候选答案。**数量从提示词里现读**，不写死——
  // 写死 6 的话，换一道 4 空的题就会被形状校验拒掉，而那正是这条链路要测的东西，
  // 分不清"校验起作用了"和"替身答错了"。
  if (promptText.includes('请给出正确选项')) {
    const m = promptText.match(/^\s*([A-Z])\s*[.、．]/m);
    return JSON.stringify({ choice: m ? m[1] : 'A' });
  }
  if (promptText.includes('blanks 的长度必须正好是')) {
    const n = Number(promptText.match(/正好是\s*(\d+)/)?.[1] || 1);
    return JSON.stringify({ blanks: Array.from({ length: n }, (_, i) => `替身第${i + 1}空`) });
  }
  if (promptText.includes('每条是一句可独立判定命中与否的要点')) {
    const n = Number(promptText.match(/共\s*(\d+)\s*条/)?.[1] || 1);
    return JSON.stringify({ points: Array.from({ length: n }, (_, i) => `替身采分点${i + 1}`) });
  }
  if (promptText.includes('下面是一道简答题')) return JSON.stringify({ answer: '替身参考答案' });

  // 连通性自测：后台"测试连接"发的探针，不属于任何一类功能
  if (promptText.includes('回复两个字')) return JSON.stringify({ ok: true });

  // 分发不到就明说。
  //
  // N3 把提示词搬进了数据库，模板措辞一改，上面这些固定短语就匹配不上。
  // 原来这里回落成 { ok: true }，于是 AI 调用"成功"、作文却判不出分，
  // 报错是一句 ai_bad_shape，看不出根因在替身这边——查了很久。
  // 这正是替身的结构性盲区：它照我们要的形状返回，所以本地怎么跑都像是对的。
  return JSON.stringify({
    stubCannotClassify: true,
    hint: '替身按提示词里的固定短语分发。改了模板措辞就分发不到，'
        + '表现为"调用成功但结果不对"。对照 migrations/0009_subject_pack.sql 里的模板。',
    promptHead: promptText.slice(0, 120),
  });
}

// 最近一次收到的提示词。N5b 要验一件替身平时验不了的事：喂给模型的题干里，
// ![fig1] 有没有真的被换成 [图：alt]（§6.4.6、G3）。这件事只有"模型那头收到了什么"
// 说得清——单测能证明替换函数对，证明不了调用方记得传 assets。
let lastPrompt = '';
// 一次 /ai/.../run 会并发发好几条（错题分析每题一条、作文批改一条），
// 只留最后一条的话，断言要看的那条很可能被别的盖掉。
const allPrompts = [];

const server = http.createServer((req, res) => {
  if (req.url === '/last-prompt') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ prompt: lastPrompt, prompts: allPrompts }));
    return;
  }
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
    lastPrompt = promptText;
    allPrompts.push(promptText);
    if (allPrompts.length > 50) allPrompts.shift();

    let content;
    if (req.url.startsWith('/bad/')) {
      content = '这不是 JSON，故意的';
    } else if (req.url.startsWith('/wrongshape/')) {
      // 合法 JSON、字段名也对，就是数量不对（少给一项）。
      if (promptText.includes('请给出正确选项')) {
        // 选择题的"形状不对"另有一种：字段对、是个字母，但**不是这道题的选项**。
        // 真实模型偶尔会回一个题面里根本没有的字母，而它长得完全合法——
        // 只有"这个字母在不在本题选项里"那道校验拦得住。
        content = JSON.stringify({ choice: 'Z' });
      } else {
        const n = Number(promptText.match(/正好是\s*(\d+)/)?.[1]
          || promptText.match(/共\s*(\d+)\s*条/)?.[1] || 2);
        content = JSON.stringify(promptText.includes('blanks')
          ? { blanks: Array.from({ length: Math.max(0, n - 1) }, (_, i) => `少一个${i}`) }
          : { points: Array.from({ length: Math.max(0, n - 1) }, (_, i) => `少一个${i}`) });
      }
    } else {
      content = reply(promptText);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    }));
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`AI 替身已启动: http://127.0.0.1:${PORT}`));
