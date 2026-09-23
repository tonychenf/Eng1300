// 判分器注册表。**按判分策略注册，不按学科注册**（需求文档 §6.4.4 末尾）。
//
// 学科在题型声明里写"我这种题用哪个策略"，得分单元还能逐个覆盖。加一个学科不该
// 往这里加代码，只有出现**新的判分口径**时才加——这和归一化器那条规矩是同一条。
import { exactGrader } from './exact.js';
import { setGrader } from './set.js';
import { numericGrader } from './numeric.js';
import { enumGrader } from './enum.js';
import { aiScorePointsGrader } from './ai-score-points.js';
import { aiDimensionGrader } from './ai-dimension.js';
import { aiLevelBandedGrader } from './ai-level-banded.js';
import { manualGrader } from './manual.js';
import { fail } from './util.js';

export const GRADERS = {
  EXACT: exactGrader,
  SET: setGrader,
  NUMERIC: numericGrader,
  ENUM: enumGrader,
  AI_SCORE_POINTS: aiScorePointsGrader,
  AI_DIMENSION: aiDimensionGrader,
  AI_LEVEL_BANDED: aiLevelBandedGrader,
  MANUAL: manualGrader,
};

// §6.4.4 的策略表里有、这一版没实现的。**空着比糊一个上去强**：
// SEQUENCE 如果照 EXACT 那样按位置逐个比，就是一个换了名字的 EXACT，而排序题真正
// 的分歧在部分分口径——"A C B D" 对 "A B C D"，按位置算错 2 个，按相对先后算只错
// 1 对，两种都是通行做法，结果差一倍。没有排序题内容之前定不下来，也测不了。
// 解析时抛错，管理员当场看到"这条策略还没实现"，而不是拿到一个猜出来的判分口径。
export const NOT_IMPLEMENTED = {
  SEQUENCE: '排序题的部分分口径未定（按位置比对 / 按相对先后比对，两种都合法且结果差很多），' +
            '等有排序题内容、口径定下来再实现',
};

/** §6.4.4 维度一：作答形态。决定前端控件与答案存储格式，判分不看它。 */
export const ANSWER_SHAPES = [
  'CHOICE_ONE', 'CHOICE_MANY', 'TEXT_SHORT', 'NUMBER', 'TEXT_LONG', 'ORDERING', 'MATCHING',
];

/** 后台界面要能列出有哪些策略、各自要不要 AI。前端不该自己抄一份这张表。 */
export const STRATEGY_INFO = [
  ...Object.values(GRADERS).map((g) => ({
    code: g.strategy, needsAi: !!g.needsAi, manual: !!g.manual, implemented: true,
  })),
  ...Object.entries(NOT_IMPLEMENTED).map(([code, why]) => ({
    code, needsAi: false, manual: false, implemented: false, why,
  })),
];

export const STRATEGIES = Object.keys(GRADERS);
export const ALL_STRATEGIES = [...STRATEGIES, ...Object.keys(NOT_IMPLEMENTED)];

/**
 * 策略名 → 判分器。认不出就抛错，不回落 EXACT。
 * 回落的后果是：数值题被当成文本精确比对，280.0 判成错，而没有任何地方报错。
 */
export function resolveGrader(strategy, where) {
  const g = GRADERS[strategy];
  if (g) return g;
  if (NOT_IMPLEMENTED[strategy]) {
    throw fail('strategy_not_implemented', `${where} 用的判分策略 ${strategy}：${NOT_IMPLEMENTED[strategy]}`);
  }
  throw fail('unknown_strategy',
    `${where} 声明了判分策略 ${JSON.stringify(strategy)}，注册表里只有 ${ALL_STRATEGIES.join('、')}`);
}

export { fail } from './util.js';
export { dimensionRate } from './ai-dimension.js';
