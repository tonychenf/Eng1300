// requireAuth 的失败路径（CR-M5、CR-M2）。不起服务，拿一个假的 Hono 上下文直接调中间件。
//
// 这几条替身测得了、集成测试反而测不了：要让"查库出错"在真服务上复现，
// 得把 users 表弄坏，而那会连带打坏同一套里的其他断言。
// 替身只证明分支走向（标准 §2.1：协议约束与降级路径），不证明数据库真会这样坏。
import { signToken, requireAuth } from '../src/lib/auth.js';

const env = { JWT_SECRET: 'auth-guard-test-secret' };
let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (String(got) === String(want)) { console.log(`  OK   ${desc}`); pass++; }
  else { console.log(`  FAIL ${desc}（期望 ${want}, 实际 ${got}）`); fail++; }
};

// 假上下文：只实现 requireAuth 用到的那几个口子
function ctx(token, db) {
  const store = new Map();
  return {
    req: { header: (k) => (k === 'Authorization' && token ? `Bearer ${token}` : undefined) },
    env: { ...env, DB: db },
    json: (body, status) => ({ body, status }),
    set: (k, v) => store.set(k, v),
    get: (k) => store.get(k),
  };
}
const dbReturning = (row) => ({
  prepare: () => ({ bind: () => ({ first: async () => row }) }),
});
const dbThrowing = (msg) => ({
  prepare: () => ({ bind: () => ({ first: async () => { throw new Error(msg); } }) }),
});

// 跑一次中间件，返回 { res, nextCalled, threw }
async function run(token, db) {
  let nextCalled = false;
  const c = ctx(token, db);
  try {
    const res = await requireAuth(c, async () => { nextCalled = true; });
    return { res, nextCalled, threw: null, c };
  } catch (e) {
    return { res: null, nextCalled, threw: e, c };
  }
}

const student = { id: 7, username: 'T007', role: 'USER', disabled: 0, token_version: 0 };
const good = await signToken(env, student);

{
  const r = await run(good, dbReturning(student));
  check('令牌有效、账号正常：放行', r.nextCalled, true);
  check('  放行时把用户放进了上下文', r.c.get('user')?.username, 'T007');
}
{
  const r = await run('not-a-jwt', dbReturning(student));
  check('令牌坏了：401', r.res?.status, 401);
  check('  令牌坏了不放行', r.nextCalled, false);
}
{
  const r = await run(null, dbReturning(student));
  check('没带令牌：401', r.res?.status, 401);
}
{
  const r = await run(good, dbReturning({ ...student, disabled: 1 }));
  check('账号已停用：401', r.res?.status, 401);
}
{
  // CR-M5 的核心：查库出错不是"未登录"。回 401 的话前端会清掉登录状态，把人踢回登录页。
  const r = await run(good, dbThrowing('D1_ERROR: Network connection lost'));
  check('令牌有效但查库出错：不回 401（错误往上抛，由 app.onError 回 500/503）',
    r.res?.status === 401 ? '回了 401' : (r.threw ? '抛出' : `回了 ${r.res?.status}`), '抛出');
  check('  抛出来的就是那个数据库错误，没被换成别的', r.threw?.message, 'D1_ERROR: Network connection lost');
  check('  查库出错时不放行', r.nextCalled, false);
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail === 0 ? 0 : 1);
