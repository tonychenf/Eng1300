// MANUAL：人工阅卷（§6.4.4 点名 v2 漏掉的那一格）。
//
// 本期**不实现阅卷界面**，但判分骨架必须留出口，否则将来补它要动主链路。
// 出口就是这里：声明了 MANUAL 的题永远不自动判分，交卷时记"待人工判分"，
// 客观题的分先出，主观题等阅卷。
//
// 判分器本身没有 gradeGroup——它不是"还没写完"，而是这条策略**不该**有自动判分。
// 循环看到 manual 就跳过，真调到这里说明循环写错了，当场抛错比返回 0 分强。
import { fail } from './util.js';

export const manualGrader = {
  strategy: 'MANUAL',
  needsAi: false,
  manual: true,
  gradeGroup(group) {
    throw fail('manual_not_auto_gradable',
      `单元组 ${group.key} 是人工阅卷，不该走到自动判分`);
  },
};
