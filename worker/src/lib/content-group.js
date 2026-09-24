// 内容组（exams 表）的读出口（§6.4.2）。
//
// 内容组是"一批题的容器"：英语是一套真题，生化是教材的一章。
// 它们之间真正的结构性差异只有一件事——**怎么排序**，那就是 order_key。
// label 是显示名，meta 是展示与筛选用的 JSON。
//
// **不允许任何逻辑分支依赖 subjects.content_group_kind。** 它只决定界面上
// 管这东西叫"试卷"还是"章节"。这一条写进代码评审清单（§6.4.2）。

/**
 * year/month 是 NOT NULL 而生化没有年月，所以库里写 0（理由见 0002_bank.sql）。
 * **这里是那个 0 唯一的出口**：读出去的一律是 null，界面永远拿不到 0。
 * 只在这一个函数里做映射，是为了让"哪里会漏"这个问题有一个确定的答案。
 */
export function shapeContentGroup(row) {
  if (!row) return row;
  const out = { ...row };
  if (out.year === 0) out.year = null;
  if (out.month === 0) out.month = null;
  if (typeof out.meta === 'string') {
    // meta 存坏了不要让整张列表 500。它只用于展示，读不出来就当没有——
    // 这不是"读不到值回落默认值"那一类：meta 缺失本来就是合法状态（英语不写），
    // 判分、抽题、排序一概不看它。
    try { out.meta = out.meta ? JSON.parse(out.meta) : null; } catch { out.meta = null; }
  }
  return out;
}

/** 内容组的统一排序：order_key 降序（最近的 / 最后一章在前），同键按 exam_id 稳定。 */
export const ORDER_BY_RECENT = 'ORDER BY e.order_key DESC, e.exam_id';
