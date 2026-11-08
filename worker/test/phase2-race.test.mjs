// 改进阶段 2 第一期的两处并发（PRD 第 11 节）。纯 node，不起服务——本地 wrangler dev 把同时到的请求排了队，
// 经本地服务测不出并发（同 submit-race.test.mjs 顶部的说明，用的也是同一套 node:sqlite 上的 D1 替身和闸）。
//
//   ① 组卷模板两人同时保存：一个成功、一个 409，模板只写一份（版本号守卫在 batch 里，失效语句排最后）；
//   ② 练习里同一道翻译题同时交两次：作答记录一条、错题本只算一次。两次 AI 调用挡不住（守卫只挡写入），
//      两次都记账、都算今日次数——这是每天上限兜着的已知代价，这里把它断出来，免得以后有人以为挡住了。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import app from '../src/index.js';
import { signToken } from '../src/lib/auth.js';
import { encryptSecret } from '../src/lib/crypto.js';
import { makeDb, WORKER_ROOT } from './lib/d1-sqlite.mjs';

let pass = 0, fail = 0;
const check = (desc, got, want) => {
  if (Object.is(got, want)) { pass++; console.log(`  OK   ${desc}`); }
  else { fail++; console.log(`  FAIL ${desc} (期望 ${JSON.stringify(want)}, 实际 ${JSON.stringify(got)})`); }
};

// ── 库：迁移 + 公共英语题库（现生成种子，不消费别人留下的产物） ─────────────
const { sqlite, DB, gate, tick } = makeDb({});
const seedDir = mkdtempSync(join(tmpdir(), 'ph2race-'));
execFileSync('node', [join(WORKER_ROOT, '../scripts/build-seed-sql.mjs'), seedDir],
  { env: { ...process.env, SEED_SUBJECT_DIR: join(WORKER_ROOT, '../data/subjects/pubeng') }, stdio: 'pipe' });
for (const f of readdirSync(seedDir).sort()) sqlite.exec(readFileSync(join(seedDir, f), 'utf8'));
rmSync(seedDir, { recursive: true, force: true });
sqlite.exec(`UPDATE questions SET answer_state = '已确认' WHERE course_code = 'pubeng-main';`);
sqlite.exec(readFileSync(join(WORKER_ROOT, 'test/fixtures/publish-all.sql'), 'utf8'));

const env = { DB, JWT_SECRET: 'ph2-race-secret', ENCRYPTION_KEY: 'ph2-race-encryption-key' };
const one = (sql, ...p) => { const r = sqlite.prepare(sql).get(...p); return r ? { ...r } : null; };
const peId = one("SELECT subject_id FROM subjects WHERE code = 'pubeng'").subject_id;

// 假 AI：采分点全答到。从提示里的 JSON 示例读出采分点序号（和 test/ai-stub.mjs 同一个读法）
let aiCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (!String(url).startsWith('http://fake-ai/')) return realFetch(url, init);
  aiCalls++;
  await tick();
  const text = JSON.parse(init.body).messages.map((m) => m.content).join('\n');
  const MARK = '只输出这个 JSON：';
  const ords = Object.keys(JSON.parse(text.slice(text.lastIndexOf(MARK) + MARK.length).trim()).points);
  const points = Object.fromEntries(ords.map((o) => [o, { hit: true, reason: '假 AI：答到了' }]));
  return new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify({ points }) } }],
    usage: { prompt_tokens: 100, completion_tokens: 50 },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
sqlite.prepare(`INSERT INTO ai_settings (purpose, subject_id, base_url, api_key_encrypted, model, protocol)
                VALUES ('TUTORING', 0, 'http://fake-ai/v1', ?, 'fake', 'openai')`)
  .run(await encryptSecret('fake-key', env.ENCRYPTION_KEY));

async function user(name, role = 'USER') {
  const id = Number(sqlite.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, 'x', ?)")
    .run(name, role).lastInsertRowid);
  if (role === 'USER') {
    sqlite.prepare("INSERT INTO user_subject_grants (user_id, subject_id, status) VALUES (?, ?, 'ACTIVE')").run(id, peId);
  }
  return { id, token: await signToken(env, { id, username: name, role, token_version: 0 }) };
}
async function call(who, method, path, body) {
  const headers = { Authorization: `Bearer ${who.token}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await app.request(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, env);
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  return { status: res.status, json };
}
// 闸：先到的带写入的 batch 停下，等第二个也到了再放行（同 submit-race.test.mjs）
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
      await tick();
    }
  };
  return g;
}

// ── ① 组卷模板两人同时保存 ─────────────────────────────────────────────
console.log('== 组卷模板两人同时保存：一个成功、一个 409 ==');
{
  const admin = await user('RADMIN', 'SUPER_ADMIN');
  const view = (await call(admin, 'GET', `/admin/subjects/${peId}/template`)).json;
  const items = view.items.map(({ label, filter, pickUnit, questionCount, scorePerQuestion }) =>
    ({ label, filter, pickUnit, questionCount, scorePerQuestion }));
  const before = one("SELECT COUNT(*) AS n FROM exam_template_items WHERE course_code = 'pubeng-main'").n;
  const g = pairGate();
  const rs = await Promise.all([
    call(admin, 'PUT', `/admin/subjects/${peId}/template`, { version: view.version, items: items.map((x, i) => (i === 0 ? { ...x, label: '甲改的' } : x)) }),
    call(admin, 'PUT', `/admin/subjects/${peId}/template`, { version: view.version, items: items.map((x, i) => (i === 0 ? { ...x, label: '乙改的' } : x)) }),
  ]);
  gate.hook = null;
  check('两边都读到了同一个版本号、都走到了写库（前提成立）', g.met, true);
  check('一个 200、一个 409', rs.map((r) => r.status).sort().join(','), '200,409');
  check('409 说的是模板刚被改过', rs.find((r) => r.status === 409)?.json?.error, 'template_changed');
  check('模板只有一份（行数没翻倍）', one("SELECT COUNT(*) AS n FROM exam_template_items WHERE course_code = 'pubeng-main'").n, before);
  // 成功的是哪一方，按它自己提交的内容认（不能拿它响应里读回的模板认——那是保存完再读的库，和下面那句同源）
  const winner = rs[0].status === 200 ? '甲改的' : '乙改的';
  check('库里第 1 项是成功那一方写的', one("SELECT label FROM exam_template_items WHERE course_code = 'pubeng-main' AND ord = 1").label, winner);
  check('版本号只加了 1', one("SELECT template_version AS v FROM courses WHERE course_code = 'pubeng-main'").v, view.version + 1);
  check('审计只记了成功的那一次', one("SELECT COUNT(*) AS n FROM admin_audit WHERE action = 'template.update'").n, 1);
}

// ── ② 练习里同一道翻译题同时交两次 ─────────────────────────────────────
console.log('== 练习同一道翻译题同时交两次：作答记录一条 ==');
{
  const s = await user('R101');
  const p = (await call(s, 'POST', '/practice/start', { courseCode: 'pubeng-main', sectionTypes: ['词组翻译'] })).json.attemptId;
  const q = one(`SELECT question_id, section_id FROM questions WHERE course_code = 'pubeng-main' AND question_type = 'phrase_translate'
                 ORDER BY question_id LIMIT 1`);
  sqlite.prepare(`INSERT INTO attempt_questions (attempt_id, ord, question_id, section_id, section_ord, score_per_question)
                  VALUES (?, 1, ?, ?, 0, 0)`).run(p, q.question_id, q.section_id);
  aiCalls = 0;
  const g = pairGate();
  // 两份作答不一样：一样的话第二个会命中第一个写下的缓存——这里要测的是"都调了 AI、都要写作答记录"
  const rs = await Promise.all(['甲的译文', '乙的译文'].map((a) =>
    call(s, 'POST', `/practice/${p}/answer`, { questionId: q.question_id, answer: a })));
  gate.hook = null;
  check('两次都读到了"没答过"、都走到了写库（前提成立）', g.met, true);
  check('一个 200（批了）、一个 409', rs.map((r) => r.status).sort().join(','), '200,409');
  check('成功那个是当场 AI 批的', rs.find((r) => r.status === 200)?.json?.aiGraded, true);
  check('作答记录只有一条', one('SELECT COUNT(*) AS n FROM answer_records WHERE attempt_id = ?', p).n, 1);
  check('两次 AI 调用都发生了（守卫只挡写入，挡不住调用）', aiCalls, 2);
  check('两次都记了账、都算今日次数（每天上限兜着这件事）',
    one("SELECT COUNT(*) AS n FROM ai_usage_logs WHERE user_id = ? AND feature = 'practice_point_grade'", s.id).n, 2);
}

globalThis.fetch = realFetch;
console.log(`\n== 小结: ${pass} 通过, ${fail} 失败 ==`);
process.exit(fail ? 1 : 0);
