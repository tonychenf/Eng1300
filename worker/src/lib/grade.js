// 判分的**通用骨架**。学科专属的部分全在能力包里：
//   - 哪些题型、用哪个判分策略、要不要 AI、判错要不要复核 → subject_question_types
//   - 大小写敏不敏感、给不给部分分、得分率到多少算答对   → subject_rubrics.grading / mastery
//   - 什么算"等价"                                      → src/normalizers/ 里的归一化器
//   - 分怎么算出来                                      → src/graders/ 里的判分器
//
// 蓝本这个文件整个是英语判分（29 组英美拼写对照、三条 -ise/-ize 规则、OUR_KEEP
// 例外表）。那些内容现在在 src/normalizers/en-spelling.js，由英语的题型声明引用。
//
// **只有一个判分循环**（§6.4.5、B16）。填空的空、主观题的采分点、多选的选项、
// 解答题的步骤走同一段代码：归组 → 各组按自己的策略判出命中率 → 按权重汇总成得分率
// → 乘以本卷赋予该题的绝对分值。v2 为空和采分点建了两张表、两条判分路径，
// 多选部分分会逼出第三条——合并的收益就是这里只剩下面这一个 for。
import { groupItems, parseItemAnswers, toItem } from './question-items.js';
import { fail } from '../graders/index.js';

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

/** 掌握度口径：得分率到多少才算"答对"（§6.6③ question_correct_threshold）。 */
function correctThresholdOf(pack) {
  const t = Number(pack.rubric?.mastery?.correctThreshold);
  if (!Number.isFinite(t) || t <= 0 || t > 1) {
    // 取不到就抛错而不是默认 1.0：默认值恰好等于种子里那个数，于是"评价标准少配了
    // 一项"会被伪装成"配置就是这样"，一直到有人去查才发现。
    throw fail('bad_rubric',
      `学科 ${pack.code} 的 mastery.correctThreshold 取不到可用的值（读到 ` +
      `${JSON.stringify(pack.rubric?.mastery?.correctThreshold)}），得分率到多少算答对没人说了算`);
  }
  return t;
}

/**
 * 判一道题。
 *
 * @param pack            能力包，调用方一次读好传进来（见 subject-pack.js loadPack 的注释）
 * @param question        questions 表那一行
 * @param userAnswer      学生作答。多单元题是 {"序号":"答案"} 的 JSON 串
 * @param absoluteScore   **本卷赋予这道题的分值**（§6.4.7：题目只带相对权重，模板给绝对分）
 * @param opts.items      该题的 question_items 行；没有就是单值题，退化成一个单元
 * @param opts.aiResult   AI 判分结果（规整之后的形状，见 graders/ai-*.js）；没有就记待判
 *
 * 返回 { isCorrect, score, scoreRate, needsAiReview, pendingAi, pendingManual, itemResults }。
 * 需要 AI 或人工而还没有结果时 isCorrect / score 为 null——**待判和 0 分必须分得开**。
 */
export function gradeQuestion(pack, question, userAnswer, absoluteScore, opts = {}) {
  // 未声明的题型在这里抛错。能走到判分说明题目已经入库了，
  // 而入库时就该被拒——抛错是为了让"校验漏了"这件事有人看见。
  const type = pack.typeOf(question.question_type);
  const where = `题目 ${question.question_id ?? '（未知）'}`;

  const rows = Array.isArray(opts.items) ? opts.items : [];
  // 单元素退化（§6.4.5）：没有得分单元的题直接用 questions.answer 造一个单元。
  // 英语的现有路径走的就是这条，行为与蓝本一字不差——这条约束不能破。
  const items = rows.length
    ? rows.map((r) => toItem(r, where))
    : [toItem({ item_ord: 1, item_kind: 'BLANK', answer: question.answer, weight: 1 }, where)];

  const groups = groupItems(items, type.gradingStrategy, where);

  // ① 要 AI 而结果还没回来 → 待判。蓝本在这里只认 question_type === 'essay'，
  //    现在由题型声明的策略说了算。位置不能挪到"空白作答"后面：没写作文也是待判，
  //    不是 0 分。
  const needsAi = groups.some((g) => g.grader.needsAi);
  if (needsAi && !type.needsAi) {
    throw fail('ai_strategy_on_non_ai_type',
      `${where} 的题型 ${type.code} 声明 needs_ai=0，却有要 AI 判的单元组` +
      `（${groups.filter((g) => g.grader.needsAi).map((g) => g.strategy).join('、')}）：` +
      '这会让交卷时的"待批改"计数漏掉这道题');
  }
  if (!needsAi && type.needsAi) {
    // 反过来也要拦：交卷时"待批改"是按题型数的，这种题会被永远算作待批改，
    // 而它其实已经判完了——成绩单上少一块分，状态停在"AI 批改中"。
    throw fail('ai_type_without_ai_group',
      `${where} 的题型 ${type.code} 声明 needs_ai=1，但它的单元组用的都是规则判分` +
      `（${groups.map((g) => g.strategy).join('、')}）`);
  }
  if (needsAi && !opts.aiResult) {
    return {
      isCorrect: null, score: null, scoreRate: null,
      needsAiReview: true, pendingAi: true, pendingManual: false, itemResults: null,
    };
  }

  // ② 人工阅卷（§6.4.4 的 MANUAL 出口）：本期没有阅卷界面，但主链路要认得它，
  //    否则将来补界面要动这段循环。
  if (groups.some((g) => g.grader.manual)) {
    return {
      isCorrect: null, score: null, scoreRate: null,
      needsAiReview: false, pendingAi: false, pendingManual: true, itemResults: null,
    };
  }

  // ③ 一个字都没写 → 0 分，且**不送 AI 复核**。空白不是"判错了"，
  //    送去复核既费钱又没有意义（蓝本行为）。
  const answers = parseItemAnswers(userAnswer, items, where);
  if (![...answers.values()].some((v) => String(v).trim())) {
    return {
      isCorrect: 0, score: 0, scoreRate: 0,
      needsAiReview: false, pendingAi: false, pendingManual: false,
      itemResults: rows.length ? [] : null,
    };
  }
  for (const it of items) it.given = answers.get(it.ord) ?? '';

  const ctx = {
    pack,
    type,
    question,
    grading: pack.grading,
    // §6.6② 说的是 rubric.subjective.<题型>，这一版一个学科只有一份主观题标准
    // （生化的名词解释与问答都是采分点式），等真出现两种形状再拆。
    subjective: pack.rubric.essay,
    aiResult: opts.aiResult,
    allItemOrds: new Set(items.map((i) => i.ord)),
    canon: (raw) => canonical(pack, type, raw),
  };

  // ④ 唯一的判分循环（§6.4.5 那段伪码的实现）
  const partial = !!pack.grading?.partialCredit;
  const itemResults = [];
  let got = 0;
  let totalWeight = 0;
  let allFull = true;
  for (const g of groups) {
    const res = g.grader.gradeGroup(g, ctx);
    got += res.rate * g.weight;
    totalWeight += g.weight;
    if (res.rate < 1) allFull = false;
    itemResults.push({
      group: g.key, strategy: g.strategy, weight: g.weight,
      rate: res.rate, scored: 0, items: res.items,
      ...(res.detail ? { detail: res.detail } : {}),
    });
  }
  if (!(totalWeight > 0)) throw fail('bad_item_weight', `${where} 的得分单元权重合计为 0`);

  // 不给部分分的学科：**整道题**只有满分或零分，不是"每个单元组各自只有满分或零分"。
  // §6.4.5 那段伪码把这个开关写在组一级，但组一级管不住它要管的事——一道 10 空的题
  // 拆成 10 个单组，逐组判完再加起来还是 0.7 分，而 §6.6① 说的 partial_credit=false
  // 是"不按空给部分分"（蓝本口径：本部分无 0.5 分和 1 分的计分）。所以判在题一级。
  // 单组题（英语现有的全部题目）两种写法结果完全一样。
  const scoreRate = partial ? round6(got / totalWeight) : (allFull ? 1 : 0);
  // 逐组得分要和题目得分率同口径：不给部分分时整道题同生共死，各组也就只有满分或零分。
  // 两处各按各的算，报告上会出现"逐项加起来不等于总分"。
  for (const r of itemResults) r.scored = round6(partial ? r.rate * r.weight : (allFull ? r.weight : 0));
  // 分值保留两位小数。得分率是 1 或 0 时乘法本来就是精确的，所以英语那条路径
  // （每题 1 / 1.5 / 2 分）不受这一步影响。
  const score = Math.round(scoreRate * absoluteScore * 100) / 100;

  return {
    // B13：得分率 0.7 的题按默认阈值 1.0 记为"答错"，该考点继续被抽到
    isCorrect: scoreRate >= correctThresholdOf(pack) ? 1 : 0,
    score,
    scoreRate,
    // 规则判错的可以交给 AI 复核。选择题的答案是闭集，复核没有意义，
    // 所以这条由题型自己声明（蓝本写死在 if 分支里）。
    needsAiReview: scoreRate < 1 && type.aiReviewOnMiss,
    pendingAi: false,
    pendingManual: false,
    itemResults: rows.length ? itemResults : null,
  };
}

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}
