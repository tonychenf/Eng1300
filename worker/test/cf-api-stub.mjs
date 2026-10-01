// 假的 Cloudflare D1 接口（CR-M6 / M15）：只认列库、建库、删库三个动作，给 d1-ops-guard.sh 测
// find-or-create-d1.sh、d1-create-db.sh、d1-delete-db.sh 的分支用。本地连不上 api.cloudflare.com。
//
// 它只能证明"我们的脚本在各种回复下走哪条路、发没发出建库删库的请求"——协议和分支；
// 真接口的行为（名字查询是不是前缀匹配、删库是不是立即生效）只有 d1-drill 在线上演练时才看得到。
//
// 用法：node cf-api-stub.mjs <端口> <状态文件> <请求日志>
//   状态文件：{"databases":[{"name":"xlearn","uuid":"u-1"}],"failList":false}，每个请求都现读，测试改它就能换场景
//   请求日志：每个请求追加一行 "方法 路径"
import http from 'node:http';
import fs from 'node:fs';

const [port, statePath, logPath] = process.argv.slice(2);
const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const write = (s) => fs.writeFileSync(statePath, JSON.stringify(s));
const send = (res, code, body) => {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://stub');
  fs.appendFileSync(logPath, `${req.method} ${url.pathname}${url.search}\n`);
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const m = url.pathname.match(/^\/client\/v4\/accounts\/[^/]+\/d1\/database(?:\/([^/]+))?$/);
    if (!m) return send(res, 404, { success: false, errors: [{ message: `stub: 不认识 ${url.pathname}` }] });
    const state = read();
    if (req.method === 'GET' && !m[1]) {
      if (state.failList) return send(res, 403, { success: false, errors: [{ code: 10000, message: 'stub: 没权限' }] });
      const q = url.searchParams.get('name') || '';
      return send(res, 200, { success: true, result: state.databases.filter((d) => d.name.includes(q)) });
    }
    if (req.method === 'POST' && !m[1]) {
      const { name } = JSON.parse(body || '{}');
      const uuid = `stub-${state.databases.length + 1}-${name}`;
      state.databases.push({ name, uuid });
      write(state);
      return send(res, 200, { success: true, result: { uuid, name } });
    }
    if (req.method === 'DELETE' && m[1]) {
      const before = state.databases.length;
      state.databases = state.databases.filter((d) => d.uuid !== m[1]);
      write(state);
      return send(res, 200, { success: before !== state.databases.length, result: null });
    }
    return send(res, 405, { success: false, errors: [{ message: 'stub: 不支持' }] });
  });
}).listen(Number(port), '127.0.0.1');
