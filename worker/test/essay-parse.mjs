// 作文批改的取分逻辑。
//
// 线上实测踩到过：真实模型返回的 JSON 合法，键名却不是我们要的那套，五个维度
// 全都取不到，于是作文被判 0 分、状态还是"批改成功"——学生看到一个理直气壮的
// 零分，没人知道是没读懂模型的回复。替身按我们要的形状返回，本地发现不了。
//
// 所以这几种形状要单独钉住：平铺、嵌在 scores 里、数字写成字符串、带单位、
// 以及"一个维度都读不到"必须抛错而不是记 0。
//
// CR-M11 之前这里测的是把 gradeEssay 的取分段落**抄过来**的一份，抄来的那份和
// tutor.js 改一处忘一处，测试照样全绿。现在直接测 tutor.js 导出的 scoreEssayReply。
import assert from 'node:assert/strict';
import { essayRubric, scoreEssayReply } from '../src/lib/tutor.js';

// 英语作文的评分标准：五维、各 0–6 分、合成 30 分（与 0009 种子里的一致）
const R = essayRubric({
  code: 'english',
  rubric: {
    essay: {
      type: 'DIMENSION_WEIGHTED', dimensionMax: 6, totalScore: 30,
      dimensions: [
        { key: 'content', name: '内容', weight: 0.30 },
        { key: 'language', name: '语言', weight: 0.25 },
        { key: 'vocabulary', name: '词汇', weight: 0.15 },
        { key: 'coherence', name: '连贯', weight: 0.20 },
        { key: 'length', name: '篇幅', weight: 0.10 },
      ],
    },
  },
});
const extract = (data) => scoreEssayReply(data, R);
const WHY = { content: '完全没有回应写作要求，属于跑题。' };

let pass = 0;
const t = (name, fn) => { fn(); console.log(`  OK   ${name}`); pass++; };

t('平铺的数字', () => {
  assert.equal(extract({ content: 6, language: 6, vocabulary: 6, coherence: 6, length: 6 }).total, 30);
});
t('嵌在 scores 里', () => {
  assert.equal(extract({ scores: { content: 6, language: 6, vocabulary: 6, coherence: 6, length: 6 } }).total, 30);
});
t('嵌在 result 里', () => {
  assert.equal(extract({ result: { content: 3, language: 3, vocabulary: 3, coherence: 3, length: 3 } }).total, 15);
});
t('数字写成字符串', () => {
  assert.equal(extract({ content: '6', language: '6', vocabulary: '6', coherence: '6', length: '6' }).total, 30);
});
t('数字带单位', () => {
  assert.equal(extract({ content: '5.5分', language: '6 分', vocabulary: '6', coherence: '6', length: '6' }).scores.content, 5.5);
});
t('超出 0-6 的分数被夹住', () => {
  assert.equal(extract({ content: 99, language: -5, vocabulary: 6, coherence: 6, length: 6 }).scores.content, 6);
  assert.equal(extract({ content: 99, language: -5, vocabulary: 6, coherence: 6, length: 6 }).scores.language, 0);
});
t('只读到一部分维度也算数，其余按 0', () => {
  const r = extract({ content: 6, language: 6 });
  assert.equal(r.scores.vocabulary, 0);
  assert.ok(r.total > 0);
});
t('一个维度都读不到必须抛错，不能记 0 分', () => {
  assert.throws(() => extract({ 内容: 5, 语言: 5, 总分: 25 }), /ai_bad_shape/);
  assert.throws(() => extract({}), /ai_bad_shape/);
});

// ---- CR-M11：模型把示例原样抄回来 ----
// 用的就是 tutor.js 拼给模型的那段示例（R.jsonShape），不是手写一份"长得像"的：
// 示例的写法哪天改了，这条跟着变，不会测一个模型根本收不到的形状。
t('模型把提示里的示例原样抄回来：抛 ai_bad_shape，不记成已批改的 0 分', () => {
  const echoed = JSON.parse(R.jsonShape);
  assert.ok(Object.values(echoed).some((v) => v === 0), '（前提）示例里的维度分确实是用 0 占位的');
  assert.throws(() => extract(echoed), /ai_bad_shape.*原样抄/);
});
t('只抄回一部分、分数全 0、没有评语：同样当没读懂', () => {
  assert.throws(() => extract({ content: 0, comments: { content: '  ' } }), /原样抄/);
});
t('真零分带了评语：照样是 0 分，不误判为解析失败', () => {
  const r = extract({ content: 0, language: 0, vocabulary: 0, coherence: 0, length: 0, comments: WHY });
  assert.equal(r.total, 0);
  assert.equal(r.comments.content, WHY.content);
});
t('真零分只给了建议、没给评语：也不算抄示例', () => {
  assert.equal(extract({ content: 0, language: 0, vocabulary: 0, coherence: 0, length: 0,
    suggestions: ['先读懂题目要求再动笔', '', ''] }).total, 0);
});
t('有分数时评语全空也不拦（只拦"全 0 且什么都没说"）', () => {
  assert.equal(extract({ content: 3, language: 3, vocabulary: 3, coherence: 3, length: 3,
    comments: { content: '', language: '' }, suggestions: ['', '', ''] }).total, 15);
});

console.log(`\n== 小结: ${pass} 通过, 0 失败 ==`);
