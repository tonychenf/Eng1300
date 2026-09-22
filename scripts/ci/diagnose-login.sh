#!/usr/bin/env bash
# 临时诊断：线上登录返回 500，用 wrangler tail 抓一次真实请求的 Worker 日志，
# 看究竟是代码抛异常还是运行时超限。定位到原因后连同流水线里的这一步一起删掉。
#
# 需要环境变量：WORKER_URL、ADMIN_PASSWORD、CLOUDFLARE_API_TOKEN
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../../worker"

[ -n "${ADMIN_PASSWORD:-}" ] || { echo '(没有 ADMIN_PASSWORD，跳过)'; exit 0; }

npx wrangler tail --format json > /tmp/tail.json 2>/tmp/tail.err &
TAIL_PID=$!
sleep 12   # 等 tail 真正连上，否则抓不到这次请求

echo "--- 探一次登录 ---"
curl -sS -m 30 -o /tmp/probe.json -w 'HTTP %{http_code}\n' -X POST "$WORKER_URL/api/auth/login" \
  -H 'Content-Type: application/json' \
  --data "$(jq -n --arg p "$ADMIN_PASSWORD" '{username:"admin",password:$p}')" || true
cat /tmp/probe.json; echo

sleep 8
kill "$TAIL_PID" 2>/dev/null || true

echo "--- Worker 抛出的异常与日志 ---"
# 只挑关键字段：整条事件里 request.cf 有几百行，全打出来会把要看的挤掉
jq -c '{outcome, exceptions, logs: [.logs[]? | {level, message}]}' /tmp/tail.json 2>/dev/null \
  || { echo '(jq 解析失败，原样输出前 3000 字节)'; head -c 3000 /tmp/tail.json; }
echo
echo "--- tail 自身的错误输出 ---"
head -c 800 /tmp/tail.err 2>/dev/null || true
echo
