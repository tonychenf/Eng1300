// 客观题判分的**通用骨架**。学科专属的部分全在能力包里：
//   - 哪些题型、哪些要 AI、判错要不要复核 → subject_question_types
//   - 大小写敏不敏感、给不给部分分         → subject_rubrics.grading
//   - 什么算"等价"                          → src/normalizers/ 里的归一化器
//
// 蓝本这个文件整个是英语判分（29 组英美拼写对照、三条 -ise/-ize 规则、OUR_KEEP
// 例外表）。那些内容现在在 src/normalizers/en-spelling.js，由英语的题型声明引用。
//
// 判分口径（沿用蓝本，依据 docs/prd.md §4.3）：只有满分或零分，没有部分分。
// 部分分要等 N5 的得分单元（question_items）到位，rubric 里的 partialCredit
// 开关先立在那儿，值为 true 时这里还不会有不同行为——这一点是有意的，
// 写成"看到 true 就按某种方式给部分分"才危险：那等于没测过的判分路径先上线了。

/**
 * 基础折叠：去首尾空白、按配置折大小写、去掉首尾标点（中间的连字符、撇号保留）。
 * 这一层与学科无关，所有文本答案都走；学科专属的等价折叠叠在它上面。
 */
export function baseFold(raw, grading) {
  let w = String(raw ?? '').trim();
  if (!grading?.caseSensitive) w = w.toLowerCase();
  if (!w) return '';
  return w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** 把一个答案折成可比形式：基础折叠 + 该题型声明的归一化器，按声明顺序。 */
export function canonical(pack, type, raw) {
  return type.normalizers.reduce((v, fn) => fn(v), baseFold(raw, pack.grading));
}

/**
 * 判一道题。
 * 返回 { isCorrect, score, needsAiReview }；需要 AI 的题型返回 isCorrect=null。
 *
 * pack 由调用方一次读好传进来（见 subject-pack.js loadPack 的注释）。
 */
export function gradeQuestion(pack, question, userAnswer, scorePerQuestion) {
  // 未声明的题型在这里抛错。能走到判分说明题目已经入库了，
  // 而入库时就该被拒——抛错是为了让"校验漏了"这件事有人看见。
  const type = pack.typeOf(question.question_type);

  if (type.needsAi) {
    return { isCorrect: null, score: null, needsAiReview: true };
  }

  const answered = String(userAnswer ?? '').trim();
  if (!answered) return { isCorrect: 0, score: 0, needsAiReview: false };

  const ok = canonical(pack, type, answered) === canonical(pack, type, question.answer);
  return {
    isCorrect: ok ? 1 : 0,
    score: ok ? scorePerQuestion : 0,
    // 规则判错的可以交给 AI 复核。选择题的答案是闭集，复核没有意义，
    // 所以这条由题型自己声明（蓝本写死在 if 分支里）。
    needsAiReview: !ok && type.aiReviewOnMiss,
  };
}
