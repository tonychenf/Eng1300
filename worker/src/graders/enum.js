// ENUM：答案必须取自题干给定的枚举（§6.4.4）。
//
// 与 EXACT 的差别不在"对不对"，而在**答错的三种方式分得开**：
//   - 填了枚举内的另一个值（高 / 低）→ 判错，学生是选错了
//   - 填了枚举外的值（中等）        → 判错，并告诉他这道题只能在给定的几个里选
//   - 标准答案不在枚举里            → 抛错，这是题库配错了，不是学生的问题
// 第三条是 ENUM 存在的真正理由：EXACT 在这种情况下只会让全班一起答错。
import { fail, groupResult, groupParam } from './util.js';
import { acceptedForms } from './exact.js';

export const enumGrader = {
  strategy: 'ENUM',
  needsAi: false,
  gradeGroup(group, ctx) {
    const options = groupParam(group, 'options');
    if (!Array.isArray(options) || !options.length) {
      throw fail('enum_options_missing',
        `单元组 ${group.key} 要按枚举判，但 params.options 是 ${JSON.stringify(options)}`);
    }
    const allowed = new Set(options.map((o) => ctx.canon(o)).filter((o) => o !== ''));
    if (!allowed.size) throw fail('enum_options_missing', `单元组 ${group.key} 的 options 归一化之后是空的`);

    const notes = [];
    const fractions = group.items.map((it, i) => {
      const forms = acceptedForms(it, ctx);
      if (!forms.some((f) => allowed.has(f))) {
        throw fail('enum_answer_not_in_options',
          `得分单元 #${it.ord} 的标准答案 ${JSON.stringify(it.answer)} 不在枚举 ` +
          `${JSON.stringify(options)} 里，这道题谁都答不对`);
      }
      const given = ctx.canon(it.given);
      if (!given) return 0;
      if (!allowed.has(given)) { notes[i] = '不在题干给定的选项里'; return 0; }
      return forms.includes(given) ? 1 : 0;
    });

    return groupResult(group, fractions, { notes, detail: { strategy: 'ENUM', options } });
  },
};
