// 交卷、练习交答案、保存作答的并发：同时到的请求只落一次库，存下的答案和判分对得上。纯 node，不起服务。
//
// 为什么不对着本地服务测：本地的 wrangler dev 在 Worker 前面把同时到的请求排了队——第一个处理完，
// 后面的才进到 Worker（2026-11-03 在交卷接口里打时间戳看到的：curl 一个进程同时发、node 的 fetch
// 同时发都一样）。所以经本地服务测，旧代码上照样全绿。线上没有这层排队，D1 每次查库还要走网络，
// 读和写之间的窗口大得多。
//
// 这里用 Hono 的 app.request() 直接调真实的接口代码，库是 node:sqlite 上跑真实迁移和种子的一个
// 小替身（D1 的 prepare / bind / first / all / run / batch）。替身的 batch 前面有一道闸：
// 先到的那个请求要写库时停下，等另一个请求也读完、走到写库那一步，再按到达顺序一个一个执行
// （D1 的 batch 是事务，几个 batch 一个接一个执行，和这里一样）。这就稳定造出了
// "两个请求都读到了'还在作答'"那种交错——每个场景都先断闸真的合上过，再断被测的行为。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import app from '../src/index.js';
import { signToken } from '../src/lib/auth.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};

// ── 库 ────────────────────────────────────────────────────────────────
const sqlite = new DatabaseSync(':memory:');
sqlite.exec('PRAGMA foreign_keys = ON');
for (const f of readdirSync(join(ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
  sqlite.exec(readFileSync(join(ROOT, 'migrations', f), 'utf8'));
}
// 和 m3-smoke 同一组卷：每个部分都凑得出篇章，组得出整卷
const seedFiles = readdirSync(join(ROOT, 'seed'));
const seed = (pattern) => {
  const f = seedFiles.find((x) => x.includes(pattern));
  if (!f) throw new Error(`worker/seed 里没有 ${pattern} 的种子，先跑 node scripts/build-seed-sql.mjs`);
  sqlite.exec(readFileSync(join(ROOT, 'seed', f), 'utf8'));
};
seed('english-000-knowledge-points');
for (const e of ['00015-2015-04', '00015-2016-04', '00015-2019-10', '13000-2026-04']) seed(e);
sqlite.exec(readFileSync(join(ROOT, 'test/fixtures/publish-all.sql'), 'utf8'));

// ── D1 替身 ───────────────────────────────────────────────────────────
const plain = (row) => (row ? { ...row } : null);
const toParam = (v) => {
  if (v === undefined) throw new Error('D1_TYPE_ERROR: 绑定了 undefined');   // D1 同样拒
  if (typeof v === 'boolean') return v ? 1 : 0;
  return v;
};
const isRead = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql);
function execOne(sql, params) {
  const st = sqlite.prepare(sql);
  if (isRead(sql)) return { results: st.all(...params).map(plain), success: true, meta: { changes: 0 } };
  const r = st.run(...params);
  return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
}
// 每个方法都先让出一次：真实的 D1 调用是异步的，别的请求在这里插得进来
const tick = () => new Promise((r) => setImmediate(r));
const gate = { hook: null };
function statement(sql, params = []) {
  return {
    sql, params,
    bind: (...vals) => statement(sql, vals.map(toParam)),
    first: async (col) => {
      await tick();
      const row = plain(sqlite.prepare(sql).get(...params));
      return col ? (row ? row[col] : null) : row;
    },
    all: async () => { await tick(); return execOne(sql, params); },
    run: async () => { await tick(); return execOne(sql, params); },
  };
}
const DB = {
  prepare: (sql) => statement(sql),
  batch: async (stmts) => {
    await tick();
    // 闸只拦带写入的 batch：读能力包也用 batch（subject-pack.js 一次读三张表），拦它就拦早了
    if (gate.hook && stmts.some((x) => !isRead(x.sql))) await gate.hook();
    sqlite.exec('BEGIN');
    try {
      const out = stmts.map((s) => execOne(s.sql, s.params));
      sqlite.exec('COMMIT');
      return out;
    } catch (e) {
      sqlite.exec('ROLLBACK');
      throw e;
    }
  },
};
const env = { DB, JWT_SECRET: 'race-test-secret' };

// 闸：先到的 batch 停下，等第二个 batch 也到了再放行，两个按到达顺序执行。
// 第二个一直不来（新代码里它可能根本走不到写库）就 2 秒后放行，met 记 false——场景据此断前提。
function pairGate() {
  const g = { met: false };
  let release = null;
  gate.hook = async () => {
    if (!release) {
      const wait = new Promise((r) => { release = r; });
      const t = setTimeout(() => release(), 2000);
      await wait;
      clearTimeout(t);
    } else {
      g.met = true;
      release();
      await tick();   // 让先到的那个先执行完
    }
  };
  return g;
}
// 闸：第一个 batch 停在门口，直到 open() 被调；reached 在它到门口时兑现
function holdGate() {
  let arrived, opened;
  const reached = new Promise((r) => { arrived = r; });
  const openP = new Promise((r) => { opened = r; });
  gate.hook = async () => { gate.hook = null; arrived(); await openP; };
  return { reached, open: opened };
}

// ── 账号与请求 ────────────────────────────────────────────────────────
const one = (sql, ...p) => plain(sqlite.prepare(sql).get(...p));
const englishId = one("SELECT subject_id FROM subjects WHERE code = 'english'").subject_id;
async function student(name) {
  const id = Number(sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', 'USER')")
    .run(name).lastInsertRowid);
  sqlite.prepare("INSERT INTO user_subject_grants (user_id, subject_id, status) VALUES (?, ?, 'ACTIVE')")
    .run(id, englishId);
  return { id, token: await signToken(env, { id, username: name, role: 'USER', token_version: 0 }) };
}
async function call(who, method, path, body) {
  const headers = { Authorization: `Bearer ${who.token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(`/api${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  }, env);
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}
async function newExam(who) {
  const r = await call(who, 'POST', '/exams/generate', { courseCode: '13000' });
  if (r.status !== 201 && r.status !== 200) throw new Error(`组卷失败 ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.attemptId;
}

// ── 场景一：两个交卷同时到 ────────────────────────────────────────────
console.log('== 两个交卷同时到：只判一次 ==');
{
  const s = await student('R001');
  const att = await newExam(s);
  const g = pairGate();
  const rs = await Promise.all([1, 2].map(() => call(s, 'POST', `/attempts/${att}/submit`)));
  gate.hook = null;
  check('两个交卷都读到了"进行中"、都走到了写库（前提成立）', g.met, true);
  check('一个 200、一个 409', rs.map((r) => r.status).sort().join(','), '200,409');
  const wb = one('SELECT COUNT(*) AS n, MAX(wrong_count) AS m FROM wrong_items WHERE user_id = ?', s.id);
  check('错题本里有题（一题没答，规则判分的都进来了）', wb.n > 0, true);
  check('错题次数没有被重复累计', wb.m, 1);
  // 掌握度不在这里断：它写的是"读出来的值推进一步"，两个请求读到的是同一份旧值，写回去也一样，
  // 这种交错下旧代码同样是对的（断了也红不了）。它的守卫和错题本是同一个，由上一条替它作证。
  check('考试记录是已交卷', one('SELECT status FROM attempts WHERE attempt_id = ?', att).status, '已交卷');
}

// ── 场景二：练习同一题同时交两次 ──────────────────────────────────────
console.log('== 练习同一题同时交两次：只算一次 ==');
{
  const s = await student('R002');
  const st = await call(s, 'POST', '/practice/start', { courseCode: '13000' });
  const p = st.json.attemptId;
  const q = (await call(s, 'GET', `/practice/${p}/next`)).json.question.questionId;
  const right = one('SELECT answer FROM questions WHERE question_id = ?', q).answer;
  const wrong = right === 'A' ? 'B' : 'A';
  const g = pairGate();
  const rs = await Promise.all([1, 2].map(() =>
    call(s, 'POST', `/practice/${p}/answer`, { questionId: q, answer: wrong })));
  gate.hook = null;
  check('两次作答都读到了"没答过"、都走到了写库（前提成立）', g.met, true);
  check('一个 200、一个 409', rs.map((r) => r.status).sort().join(','), '200,409');
  check('后到的那个说"已经作答过了"', rs.find((r) => r.status === 409)?.json?.error, 'already_answered');
  check('错题次数是 1', one('SELECT wrong_count FROM wrong_items WHERE user_id = ? AND question_id = ?', s.id, q)
    ?.wrong_count, 1);
}

// ── 场景三：交卷读完答案、还没写回时，来了一次保存 ──────────────────
console.log('== 交卷判分时插进来一次保存：存下的答案和判分对得上 ==');
{
  const s = await student('R003');
  const att = await newExam(s);
  const row = one(`SELECT aq.question_id AS q, q.answer AS a FROM attempt_questions aq
                     JOIN questions q ON q.question_id = aq.question_id
                    WHERE aq.attempt_id = ? AND q.question_type != 'essay' ORDER BY aq.ord LIMIT 1`, att);
  const g = holdGate();
  const submitting = call(s, 'POST', `/attempts/${att}/submit`);
  await g.reached;   // 交卷已经读完答案（这道题是空的）、判完分，停在写库门口
  const put = await call(s, 'PUT', `/attempts/${att}/answers`, { questionId: row.q, answer: row.a });
  g.open();
  const sub = await submitting;
  check('交卷成功', sub.status, 200);
  check('保存是在交卷落库之前到的（前提成立：它看到的还是"进行中"）', put.status, 200);
  const rec = one('SELECT user_answer, is_correct FROM answer_records WHERE attempt_id = ? AND question_id = ?',
    att, row.q);
  check('这道题按空白判的（0）', rec.is_correct, 0);
  check('记录里的答案就是判分时那份（空），不是后来存进去的正确答案', rec.user_answer, null);
}

// ── 场景四：交卷落库之后才到的保存 ────────────────────────────────────
console.log('== 交卷落库之后才到的保存：不写、回 409 ==');
{
  const s = await student('R004');
  const att = await newExam(s);
  const row = one(`SELECT aq.question_id AS q, q.answer AS a FROM attempt_questions aq
                     JOIN questions q ON q.question_id = aq.question_id
                    WHERE aq.attempt_id = ? AND q.question_type != 'essay' ORDER BY aq.ord LIMIT 1`, att);
  // 保存先读到"进行中"，停在写库之前；这时交卷整个做完，再放保存往下走。
  // 保存那一句用的是 run()，不是 batch——闸挂在 run 上：读完"进行中"之后的第一句写
  let arrived, opened;
  const reached = new Promise((r) => { arrived = r; });
  const openP = new Promise((r) => { opened = r; });
  const realRun = DB.prepare;
  let armed = true;
  DB.prepare = (sql) => {
    const st = realRun(sql);
    if (!armed || !/INSERT INTO answer_records/.test(sql)) return st;
    const wrap = (b) => ({ ...b, bind: (...v) => wrap(b.bind(...v)),
      run: async () => { armed = false; arrived(); await openP; return b.run(); } });
    return wrap(st);
  };
  const saving = call(s, 'PUT', `/attempts/${att}/answers`, { questionId: row.q, answer: row.a });
  await reached;
  DB.prepare = realRun;
  const sub = await call(s, 'POST', `/attempts/${att}/submit`);
  opened();
  const put = await saving;
  check('交卷成功（前提成立：保存停在写库之前时卷子交掉了）', sub.status, 200);
  check('晚到的保存回 409', put.status, 409);
  check('  说清是交过卷了', put.json?.error, 'already_submitted');
  const rec = one('SELECT user_answer, is_correct FROM answer_records WHERE attempt_id = ? AND question_id = ?',
    att, row.q);
  check('记录里还是判分时那份（空）', rec.user_answer, null);
}

console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
