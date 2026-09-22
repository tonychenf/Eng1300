// 作文批改的取分逻辑。
//
// 线上实测踩到过：真实模型返回的 JSON 合法，键名却不是我们要的那套，五个维度
// 全都取不到，于是作文被判 0 分、状态还是"批改成功"——学生看到一个理直气壮的
// 零分，没人知道是没读懂模型的回复。替身按我们要的形状返回，本地发现不了。
//
// 所以这几种形状要单独钉住：平铺、嵌在 scores 里、数字写成字符串、带单位、
// 以及"一个维度都读不到"必须抛错而不是记 0。
import assert from 'node:assert/strict';

// 把 gradeEssay 里的取分段落原样搬过来测——它依赖 chatJSON，整函数不好在
// 无网络环境下调；这里测的是同一套判断逻辑。
function extract(data) {
  const nested = [data, data.scores, data.score, data.result, data.dimensions]
    .filter((o) => o && typeof o === 'object');
  const readDim = (k) => {
    for (const obj of nested) {
      const raw = obj[k];
      if (raw === undefined || raw === null) continue;
      const v = typeof raw === 'number' ? raw : Number(String(raw).match(/-?\d+(\.\d+)?/)?.[0]);
      if (Number.isFinite(v)) return Math.max(0, Math.min(6, v));
    }
    return null;
  };
  const KEYS = ['content', 'language', 'vocabulary', 'coherence', 'length'];
  const found = Object.fromEntries(KEYS.map((k) => [k, readDim(k)]));
  if (KEYS.every((k) => found[k] === null)) {
    const err = new Error('ai_bad_shape'); err.code = 'ai_bad_shape'; throw err;
  }
  const scores = Object.fromEntries(KEYS.map((k) => [k, found[k] ?? 0]));
  const weighted = scores.content * 0.30 + scores.language * 0.25 +
    scores.vocabulary * 0.15 + scores.coherence * 0.20 + scores.length * 0.10;
  return { scores, total: Math.round((weighted / 6) * 30 * 10) / 10 };
}

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
t('真零分仍然是零分，不误判为解析失败', () => {
  assert.equal(extract({ content: 0, language: 0, vocabulary: 0, coherence: 0, length: 0 }).total, 0);
});

console.log(`\n== 小结: ${pass} 通过, 0 失败 ==`);
