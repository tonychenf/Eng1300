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
//   /echo/v1/chat/completions  作文批改把提示里的 JSON 示例原样抄回来（CR-M11），别的照常回
//   /kpbad/v1/chat/completions 给上传的题出答案时，答案照常、考点给得不像样（照抄示例、占位名、不是数组）
//   /stats                     采分点批改调用的次数与最大并发（?reset=1 清零）
//
// 采分点式主观题批改（生化名词解释、问答，2026-10-04）按**学生答案里的记号**决定怎么回，
// 好让一张卷里几道题各走一条路，而不是整次运行只能走一条：
//   【全对】全部答到   【全错】全部没答到（带理由）   【坏键】少一个采分点、多一个不存在的
//   【照抄】把提示里的 JSON 示例原样抄回来           【非对象】points 回成一句话
//   【单号】单号采分点答到、双号没答到
//   没有记号：答案里原样出现了哪个采分点的话，哪个就算答到（照采分点写的全中、跑题的一个不中）
// 每次故意慢 300 毫秒，好让并发上限测得出来（瞬间返回的话永远只有一个在飞）。
//
// 最后那条是 N6b 加的，它测的东西和 /bad/ 不一样：/bad/ 是"解析不出来"，
// 而真实服务商更常见的失败是"回了一个像模像样的 JSON，字段数对不上题"。
// 前者会被 JSON.parse 挡住，后者只有形状校验挡得住——而形状校验没写对时，
// 表现是半个答案被写进库，看起来像"已经录过了"。
import http from 'node:http';

const PORT = Number(process.argv[2] || 8899);

// 采分点批改：从提示里读出采分点序号（JSON 示例的键）和学生答案，按记号回
const POINTS_MARK = '逐个判断学生答案有没有答到';
function replyPoints(promptText) {
  const JSON_MARK = '只输出这个 JSON：';
  const example = promptText.slice(promptText.lastIndexOf(JSON_MARK) + JSON_MARK.length).trim();
  const ords = Object.keys(JSON.parse(example).points);
  const answer = promptText.match(/学生答案：\n([\s\S]*?)\n\n采分点共/)?.[1] || '';
  // 采分点原文：提示里形如"1.（权重 2）……"的那几行
  const text = Object.fromEntries([...promptText.matchAll(/^(\d+)\.（[^）]*）(.*)$/gm)].map((m) => [m[1], m[2]]));
  if (answer.includes('【照抄】')) return example;
  if (answer.includes('【非对象】')) return JSON.stringify({ points: '基本都答到了' });
  const hitOf = (ord) => (answer.includes('【全对】') ? true
    : answer.includes('【全错】') ? false
      : answer.includes('【单号】') ? Number(ord) % 2 === 1
        : Boolean(text[ord]) && answer.includes(text[ord]));
  const points = {};
  for (const o of ords) {
    points[o] = { hit: hitOf(o), reason: hitOf(o) ? `替身：第 ${o} 点答到了` : `替身：第 ${o} 点没有提到` };
  }
  if (answer.includes('【坏键】')) { delete points[ords[0]]; points['99'] = { hit: true, reason: '多出来的' }; }
  return JSON.stringify({ points });
}
let pointsInflight = 0;
let pointsMaxInflight = 0;
let pointsCalls = 0;

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
  //
  // N7c：答案和解析是同一次调用要的，所以替身也一起回。**只在提示词真的要了
  // explanation 时才回**——写死成总是回的话，"忘了在提示词里要解析"这个 bug
  // 就被替身盖住了，线上换成真模型才会发现一片空解析。
  const wantsExpl = promptText.includes('explanation');
  const EXPL = '替身解析：这里本该说清楚为什么选它，长度要够过下限。';
  // 2026-10-03：考点也是同一次调用要的（用户：考点由题库里的题产生）。和解析一样，
  // **只在提示词真的要了 knowledgePoints 时才回**。回两个：提示里列出的第一个已有考点
  // （照抄名字——验"复用已有的、不另起一个"），加一个固定的新名字（验"在本学科下新建、只建一次"）。
  const wantsKp = promptText.includes('knowledgePoints');
  const firstKnown = promptText.match(/本学科已有的考点[^：]*：([^、。]+)/)?.[1];
  const KPS = [...(firstKnown ? [firstKnown] : []), '替身新考点'];
  const withExpl = (o) => JSON.stringify({
    ...o,
    ...(wantsExpl ? { explanation: EXPL } : {}),
    ...(wantsKp ? { knowledgePoints: KPS } : {}),
  });

  if (promptText.includes('请给出正确选项')) {
    const m = promptText.match(/^\s*([A-Z])\s*[.、．]/m);
    return withExpl({ choice: m ? m[1] : 'A' });
  }
  if (promptText.includes('blanks 的长度必须正好是')) {
    const n = Number(promptText.match(/正好是\s*(\d+)/)?.[1] || 1);
    return withExpl({ blanks: Array.from({ length: n }, (_, i) => `替身第${i + 1}空`) });
  }
  if (promptText.includes('每条是一句可独立判定命中与否的要点')) {
    const n = Number(promptText.match(/共\s*(\d+)\s*条/)?.[1] || 1);
    return withExpl({ points: Array.from({ length: n }, (_, i) => `替身采分点${i + 1}`) });
  }
  if (promptText.includes('下面是一道简答题')) return withExpl({ answer: '替身参考答案' });

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
  if (req.url.startsWith('/stats')) {
    if (req.url.includes('reset=1')) { pointsMaxInflight = 0; pointsCalls = 0; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ pointsCalls, pointsMaxInflight, pointsInflight }));
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

    if (promptText.includes(POINTS_MARK) && !req.url.startsWith('/bad/')) {
      pointsCalls++;
      pointsInflight++;
      pointsMaxInflight = Math.max(pointsMaxInflight, pointsInflight);
      setTimeout(() => {
        pointsInflight--;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { role: 'assistant', content: replyPoints(promptText) } }],
          usage: { prompt_tokens: 100, completion_tokens: 50 },
        }));
      }, 300);
      return;
    }

    let content;
    if (req.url.startsWith('/bad/')) {
      content = '这不是 JSON，故意的';
    } else if (req.url.startsWith('/echo/')) {
      // 模型把提示里的 JSON 示例原样抄回来（CR-M11）。作文批改的示例用 0 占位、评语留空，
      // 抄回来是一个形状完全合法的"0 分"——线上实测 #6 作文拿了 0 分，这是可能的原因之一。
      // 只对作文这么做，别的调用照常回：一次 AI 运行里只让作文这一处出事，看得清是谁拦住的。
      const MARK = '只输出这个 JSON：';
      content = promptText.includes('批改这篇自考英语作文') && promptText.includes(MARK)
        ? promptText.slice(promptText.lastIndexOf(MARK) + MARK.length).trim()
        : reply(promptText);
    } else if (req.url.startsWith('/kpbad/')) {
      // 答案照常，只让考点这一处出事：选择题回一个字符串（不是数组），别的题回照抄示例的"…"、
      // 占位名、空串、超长的名字。这些一个都不该收——收下的话会成为本学科的考点，出现在每道题的备选里。
      const o = JSON.parse(reply(promptText));
      o.knowledgePoints = promptText.includes('请给出正确选项')
        ? '替身考点（不是数组）'
        : ['…', '考点1', '知识点', '', 'x'.repeat(30)];
      content = JSON.stringify(o);
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
