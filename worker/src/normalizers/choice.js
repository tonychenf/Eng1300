// 选项字母。任何有选择题的学科都能引用。
//
// 只留 A–Z：学生可能写成 "b."、"(B)"、"B、"，这些都是同一个选项。
// 不做"把第一个字母当答案"这种推断——"Bcd" 折成 "B" 是猜，不是等价。
export function choice(s) {
  return String(s ?? '').toUpperCase().replace(/[^A-Z]/g, '');
}
