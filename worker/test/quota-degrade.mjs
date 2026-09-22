// 额度用尽时的降级行为。
//
// 这条路径在本地和沙箱里都造不出来——D1 本地库没有每日额度，线上又要等额度
// 真的耗尽才碰得到。所以把判断函数单独测：判错了，线上就是登录不了。
//
// 用的错误文本取自线上实测：那次部署里 /api/auth/login 返回了
// storage_quota_exceeded，说明 Worker 侧收到的就是这个形状。
import assert from 'node:assert/strict';
import { isQuotaError, bestEffortWrite } from '../src/lib/auth.js';

let pass = 0;
const t = (name, fn) => { fn(); console.log(`  OK   ${name}`); pass++; };

const QUOTA = new Error(
  "D1_ERROR: Your account has exceeded D1's free tier daily row write limit. " +
  'Upgrade to a paid plan or wait until tomorrow (midnight UTC) to continue.'
);
const READ_QUOTA = new Error("D1_ERROR: exceeded D1's free tier daily row read limit.");
const OTHER = new Error('D1_ERROR: no such table: questions');
const PLAIN = new Error('boom');

t('认出写入额度耗尽', () => assert.equal(isQuotaError(QUOTA), true));
t('认出读取额度耗尽', () => assert.equal(isQuotaError(READ_QUOTA), true));
t('不把别的 D1 错误当成额度问题', () => assert.equal(isQuotaError(OTHER), false));
t('不把普通错误当成额度问题', () => assert.equal(isQuotaError(PLAIN), false));
t('undefined 不炸', () => assert.equal(isQuotaError(undefined), false));

const run = async () => {
  await bestEffortWrite(Promise.reject(QUOTA), '测试');
  console.log('  OK   额度错误被吞掉，调用方继续往下走'); pass++;

  await assert.rejects(() => bestEffortWrite(Promise.reject(OTHER), '测试'), /no such table/);
  console.log('  OK   非额度错误照常抛出，不会把真 bug 藏起来'); pass++;

  await bestEffortWrite(Promise.resolve('ok'), '测试');
  console.log('  OK   正常写入无副作用'); pass++;

  console.log(`\n== 小结: ${pass} 通过, 0 失败 ==`);
};
run().catch((e) => { console.error('  FAIL', e.message); process.exit(1); });
