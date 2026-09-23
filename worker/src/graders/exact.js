// EXACT：归一化后精确比对（§6.4.4）。
//
// 英语的单选与填空、生化的多数填空都走这里。归一化器做什么由题型声明，
// 这里只负责"折完之后一模一样才算命中"——**不做任何模糊匹配**。
import { fail, groupResult } from './util.js';

/** 该单元可接受的全部写法（标准答案 + 显式别名），折成可比形式。 */
export function acceptedForms(item, ctx) {
  const raw = [item.answer, ...item.altAnswers];
  const forms = raw.map((a) => ctx.canon(a)).filter((a) => a !== '');
  if (!forms.length) {
    // 没有答案的题不该进抽题池（§6.4.9 题目契约）。真走到判分还静默记 0 分的话，
    // 全班都答错，而错的是题库——这正是"读不到值就抛错"要拦的那类事。
    throw fail('item_without_answer',
      `得分单元 #${item.ord} 没有可用的标准答案（answer=${JSON.stringify(item.answer)}，` +
      `alt_answers=${JSON.stringify(item.altAnswers)}）`);
  }
  return forms;
}

export const exactGrader = {
  strategy: 'EXACT',
  needsAi: false,
  gradeGroup(group, ctx) {
    return groupResult(group, group.items.map((it) => {
      const given = ctx.canon(it.given);
      if (!given) return 0;
      return acceptedForms(it, ctx).includes(given) ? 1 : 0;
    }));
  },
};
