// 学员提交的作答（模考保存、练习交答案）在进库、进判分之前的形状检查。
//
// 作答一律是字符串：单值题是原文，多单元题是前端拼好的 {"序号":"答案"} 的 JSON 串，
// 清空是 null。以前两个接口对 answer 什么都不查：传一个对象，D1 绑定参数时抛错，回 500；
// 练习那边对象先被 String() 成 "[object Object]" 再判分，判出一个"答错了"。
// 长度不设上限的话，一个请求能往一行里塞几 MB，D1 单行有上限，报的同样是 500。
//
// 20000 字：英语作文一百来词、生化问答几百字，留了两个数量级的余量。真有人写到这个长度，
// 回一句说得清的 400，好过存进去以后整张卷交不了。

export const MAX_ANSWER_CHARS = 20000;

/** 合法返回 null，不合法返回 { error, message }，调用方原样回 400。 */
export function answerInputError(answer) {
  if (answer === undefined || answer === null) return null;
  if (typeof answer !== 'string') {
    const kind = Array.isArray(answer) ? '数组' : typeof answer;
    return { error: 'invalid_answer', message: `答案必须是文字（收到的是${kind}）` };
  }
  if (answer.length > MAX_ANSWER_CHARS) {
    return {
      error: 'answer_too_long',
      message: `答案太长了：${answer.length} 字，最多 ${MAX_ANSWER_CHARS} 字`,
    };
  }
  return null;
}
