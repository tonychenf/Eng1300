// 归一化器注册表。**按能力注册，不按学科注册**（需求文档 §5.3）。
//
// 学科在 subject_question_types.normalizers 里声明引用哪几个，
// 一个能力可以被多个学科引用：number 将来英语、生化、药学都用得上。
// 这也是 A2 的前提——加学科不该往这儿加代码，只有出现**新的语义等价判断**时才加。
import { enSpelling } from './en-spelling.js';
import { choice } from './choice.js';
import { trimCase } from './trim-case.js';

export const NORMALIZERS = {
  'en-spelling': enSpelling,
  'choice': choice,
  'trim-case': trimCase,
};

/**
 * 把声明的名字解析成函数数组。
 * 名字不认识就抛错，不静默跳过——跳过的后果是判分悄悄变严（少折一层等价），
 * 表现为"某些对的答案被判错"，而没有任何地方会报错。
 */
export function resolveNormalizers(names, where) {
  const list = Array.isArray(names) ? names : [];
  return list.map((n) => {
    const fn = NORMALIZERS[n];
    if (!fn) {
      const err = new Error(
        `unknown_normalizer: ${where} 声明了归一化器 ${JSON.stringify(n)}，` +
        `但注册表里只有 ${Object.keys(NORMALIZERS).join('、')}`
      );
      err.code = 'unknown_normalizer';
      throw err;
    }
    return fn;
  });
}
