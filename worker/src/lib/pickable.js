// 一道题"能不能被抽给学员"的判据，以及答案状态的合法取值。
//
// 为什么单独拿出来一个文件：判据有两个分量（校对状态 + 答案状态），
// 而它散落在七处查询里——组卷三处、练习三处、题型清单一处。
// 加第三个分量时漏掉一处，症状是"某道缺答案的题偶尔出现在练习里"：
// 抽题带随机，测不稳；线上也要很久才被人撞见一次。
//
// 为什么答案状态要进抽题条件，而不是只靠发布门（§6.4.10、B14）：
// 发布门管的是"进入已发布的那一刻"。答案录错了要退回重录，那时题已经是
// 已发布了——退回只改 answer_state，抽题却还照抽。**判据要直接看当下的事实，
// 不要看"某个时刻有人把过关"。**

/** 答案状态的合法取值。故意不写成表上的 CHECK，理由见 0002_bank.sql。 */
export const ANSWER_STATES = ['缺答案', '待核', '已确认'];
/** 答案可信、可以拿来判分的那一格 */
export const ANSWER_CONFIRMED = '已确认';
/** 答案来源（§6.4.10） */
export const ANSWER_SOURCES = ['OFFICIAL', 'MANUAL', 'AI'];

export const isAnswerState = (v) => ANSWER_STATES.includes(v);
export const isAnswerSource = (v) => ANSWER_SOURCES.includes(v);

/**
 * 抽题条件的 SQL 片段。alias 是 questions 表在该查询里的别名（不带点）。
 *
 * 写的是 `= '已确认'` 而不是 `IS NULL OR = '已确认'`。差别在**漏填一行的后果
 * 往哪边倒**：严格比对时漏填的题抽不出来，界面上会直接报"符合条件的已发布题
 * 只有 N 道"；放过 NULL 的话，漏填的题会带着一个没人核过的答案被发给学员，
 * 判错了也没有任何地方报错。前者吵，后者静——这一条要的就是吵。
 *
 * 线上老库补出来的列在回填前确实是 NULL，那由 ensure-columns.sh 兜：
 * 回填之后仍有 NULL 就让部署当场失败，新代码根本不会上线。
 */
export function pickableSql(alias) {
  const p = alias ? `${alias}.` : '';
  return `${p}status = '已发布' AND ${p}answer_state = '${ANSWER_CONFIRMED}'`;
}
