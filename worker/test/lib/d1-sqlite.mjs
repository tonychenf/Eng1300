// node:sqlite 上的 D1 替身：跑真实的迁移和种子，答得上接口代码用到的 prepare / bind / first / all / run / batch。
// 给纯 node 的测试用（submit-race、paper-sections）——经本地 wrangler dev 测不出来的事（并发交错、
// 组卷里的确定性场景）在这里直接调接口或库函数。
//
// 和真 D1 的差别要心里有数：这是 node 自带的 SQLite，不是 workerd 里那份；SQL 方言一致，
// 但"在线上 D1 上跑得通"要靠部署后的线上验证和线上实测，这里证明不了。
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const WORKER_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 建一个内存库：全部迁移 + 点名的种子（按文件名包含的片段找，找不到就抛错）+ 可选的 SQL 夹具。
 * 返回 { sqlite, DB, gate, one }：DB 交给接口当 env.DB；gate.hook 是带写入的 batch 执行前的闸；
 * one(sql, ...params) 直接读一行，给断言用。
 */
export function makeDb({ seeds = [], fixtures = [] } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const f of readdirSync(join(WORKER_ROOT, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(WORKER_ROOT, 'migrations', f), 'utf8'));
  }
  const seedFiles = readdirSync(join(WORKER_ROOT, 'seed'));
  for (const pattern of seeds) {
    const f = seedFiles.find((x) => x.includes(pattern));
    if (!f) throw new Error(`worker/seed 里没有 ${pattern} 的种子，先跑 node scripts/build-seed-sql.mjs`);
    sqlite.exec(readFileSync(join(WORKER_ROOT, 'seed', f), 'utf8'));
  }
  for (const f of fixtures) sqlite.exec(readFileSync(join(WORKER_ROOT, f), 'utf8'));

  const plain = (row) => (row ? { ...row } : null);
  const toParam = (v) => {
    if (v === undefined) throw new Error('D1_TYPE_ERROR: 绑定了 undefined');   // D1 同样拒
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  };
  const isRead = (sql) => /^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql);
  const execOne = (sql, params) => {
    const st = sqlite.prepare(sql);
    if (isRead(sql)) return { results: st.all(...params).map(plain), success: true, meta: { changes: 0 } };
    const r = st.run(...params);
    return { results: [], success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  };
  // 每个方法都先让出一次：真实的 D1 调用是异步的，别的请求在这里插得进来
  const tick = () => new Promise((r) => setImmediate(r));
  const gate = { hook: null };
  const statement = (sql, params = []) => ({
    sql, params,
    bind: (...vals) => statement(sql, vals.map(toParam)),
    first: async (col) => {
      await tick();
      const row = plain(sqlite.prepare(sql).get(...params));
      return col ? (row ? row[col] : null) : row;
    },
    all: async () => { await tick(); return execOne(sql, params); },
    run: async () => { await tick(); return execOne(sql, params); },
  });
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
  const one = (sql, ...p) => plain(sqlite.prepare(sql).get(...p));
  return { sqlite, DB, gate, one, tick };
}
