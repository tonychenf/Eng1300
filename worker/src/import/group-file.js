// 内容组文件（data/subjects/*/groups/*.json 那种格式）的校验与规整。
//
// 两处用：种子生成器（scripts/build-seed-sql.mjs，部署时导题库）和后台的题库文件导入
// （改进阶段 2 P1-I1，routes/admin-import.js）。放在 Worker 这一侧、脚本来取（同 import/index.js 顶部的理由）：
// 两边各写一份的话，迟早一边放行、一边拒绝——而那表现为"命令行导得进去、后台传不进去"或者反过来。
import { ANSWER_STATES, ANSWER_SOURCES, ANSWER_CONFIRMED } from '../lib/pickable.js';

// 解析存疑记录里点名的题号，这些题不参与组卷与练习。
// 记录是整卷一条条自由文本，但基本都会写明"第N题"或"第N-M题"；把这些题
// 标成"存疑"，抽题只认"已发布"，就自动跳过了。整篇少一题也凑不满模板题量，
// 所配的整个部分会一并落选，不会把原文拆散。
export function flaggedOrders(exam) {
  const flagged = new Set();
  for (const note of exam.parsingNotes || []) {
    const n = normalizeNote(note);
    // 原题有误 + 已留下订正前后（§6.4.10）：资料错了，我们改了，并且说得清改了什么。
    // 这种题**不扣**——扣下它等于把一道已经修好的题永久踢出题库。
    // 人工仍然要过一遍：整卷发布那道关要求所有记录都标为已处理，这道关还在。
    if (n.kind === '原题有误' && n.correctedFrom && n.correctedTo) continue;
    // 结构化记录直接点名题号，**绝不从正文里猜**：正文里的"第9题"说的是原卷、
    // 按题型分组之后的题号，与本文件的 order 对不上——生化选择题第 9 题是本文件
    // 第 21 题。猜错的后果是扣下一道好题、放过一道坏题，两边都不报错。
    // 从正文里认题号只对蓝本那 20 份自由文本记录成立，所以按记录的**写法**分流，
    // 不按学科分流。
    if (!n.fromText) {
      for (const o of n.questionOrders || []) flagged.add(Number(o));
      continue;
    }
    for (const m of n.note.matchAll(/第\s*(\d+)\s*[-–—~至]\s*(\d+)\s*题/g)) {
      const [a, b] = [Number(m[1]), Number(m[2])];
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) flagged.add(i);
    }
    for (const m of n.note.matchAll(/第\s*(\d+)\s*题/g)) flagged.add(Number(m[1]));
  }
  return flagged;
}

// 解析记录有两种写法：蓝本是一条自由文本，导入器产出的是带 kind 与订正留痕的对象
// （§6.4.10）。两种都要认，因为英语那 20 份是人工整理的纯文本。
export function normalizeNote(note) {
  if (typeof note === 'string') return { kind: '解析存疑', note, fromText: true };
  if (!note || typeof note.note !== 'string') {
    throw new Error(`解析记录的形状不对：${JSON.stringify(note)?.slice(0, 120)}`);
  }
  return {
    kind: note.kind || '解析存疑',
    note: note.note,
    fromText: false,
    questionOrders: Array.isArray(note.questionOrders) && note.questionOrders.length
      ? note.questionOrders : null,
    correctedFrom: note.correctedFrom ?? null,
    correctedTo: note.correctedTo ?? null,
    correctedBy: note.correctedBy ?? null,
  };
}

// 内容组的身份（§6.4.2）。蓝本叫 examId/title/year/month，生化叫 groupId/label/orderKey。
// 两套名字都认，但**落库只有一种形状**：order_key 排序、label 显示、meta 存展示用的杂项。
export function contentGroupOf(d, file) {
  const groupId = d.examId || d.groupId;
  if (!groupId) throw new Error(`${file}：既没有 examId 也没有 groupId`);
  const label = d.label || d.title;
  if (!label) throw new Error(`${file}：既没有 title 也没有 label，内容组没有显示名`);
  // order_key 是内容组之间唯一的结构性差异。**没有就抛错，不要回落成 0**——
  // 0 是个合法的排序键，回落之后这一组会静默排到最前面，而排序错了不报错。
  const hasYm = Number.isInteger(d.year) && Number.isInteger(d.month);
  const orderKey = Number.isInteger(d.orderKey) ? d.orderKey : (hasYm ? d.year * 100 + d.month : null);
  if (orderKey === null) {
    throw new Error(`${file}：算不出 order_key（既没有 orderKey，也没有成对的 year/month）`);
  }
  const meta = {};
  for (const k of ['year', 'month', 'chapterNo', 'groupKind', 'courseName', 'totalScore', 'timeLimitMinutes']) {
    if (d[k] !== undefined && d[k] !== null) meta[k] = d[k];
  }
  return {
    groupId,
    label,
    title: d.title || label,
    orderKey,
    // year/month 是 NOT NULL 而生化没有年月，所以这里写 0；读出去那一刻映射回 null
    // （worker/src/lib/content-group.js）。理由见 0002_bank.sql。
    year: hasYm ? d.year : 0,
    month: hasYm ? d.month : 0,
    meta: Object.keys(meta).length ? JSON.stringify(meta) : null,
  };
}

// 答案状态与来源（§6.4.10）。**组级必填，不给默认值**：默认成"已确认"会让一份
// 忘了声明的新学科题库带着没人核过的答案直接可发布可抽题，而这件事不会报错。
export function answerStateOf(d, qu, file) {
  const state = qu.answerState || d.answerState;
  if (!ANSWER_STATES.includes(state)) {
    throw new Error(
      `${file}：答案状态缺失或非法（题 ${qu?.questionId || '组级'}，收到 ${JSON.stringify(state)}）。` +
      `内容组要在顶层声明 answerState，取值 ${ANSWER_STATES.join(' / ')}`);
  }
  const source = qu.answerSource || d.answerSource || null;
  if (state !== '缺答案' && !ANSWER_SOURCES.includes(source)) {
    throw new Error(
      `${file}：答案状态是「${state}」却说不清来源（题 ${qu?.questionId || '组级'}，收到 ` +
      `${JSON.stringify(source)}）。取值 ${ANSWER_SOURCES.join(' / ')}`);
  }
  // 留痕只在"已确认"时有意义：待核的答案按定义就是还没人确认。
  const by = state === ANSWER_CONFIRMED ? (qu.answerReviewedBy || d.answerReviewedBy || null) : null;
  const at = state === ANSWER_CONFIRMED ? (qu.answerReviewedAt || d.answerReviewedAt || null) : null;
  return { state, source, by, at };
}

