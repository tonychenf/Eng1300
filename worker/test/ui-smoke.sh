#!/usr/bin/env bash
# 单课程界面检查的启动脚本：备库 → 起服务 → 建学员 → 跑浏览器用例 → 收摊。
set -uo pipefail
cd "$(dirname "$0")/.."
PORT=8794
BASE="http://127.0.0.1:$PORT/api"

cleanup() {
  # wrangler dev 会派生 workerd 子进程，只杀 wrangler 本身杀不掉它，
  # 它会继续占着端口，下一轮就起不来（报 Address already in use）。
  [ -n "${SERVER_PGID:-}" ] && kill -- -"$SERVER_PGID" 2>/dev/null
  rm -f .dev.vars
}
trap cleanup EXIT

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-ui
SETUP_TOKEN=test-setup-ui
ENCRYPTION_KEY=test-encryption-key-ui
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute eng1300-mvp --local --file="$m" >/dev/null 2>&1 \
    || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute eng1300-mvp --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1 \
  || { echo "导入考点失败"; exit 1; }
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  npx wrangler d1 execute eng1300-mvp --local --file="$F" >/dev/null 2>&1 \
    || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute eng1300-mvp --local --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 启动服务 =="
DEV_LOG=/tmp/ui-dev.log
for i in $(seq 1 20); do
  ss -ltn 2>/dev/null | grep -q ":$PORT " || break
  sleep 1
done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
# 本环境出站策略拒绝 wrangler dev 要连的几个 cloudflare.com 地址，
# 它要重试到超时才继续，启动可能要一分多钟。等不足就会拿没起来的服务跑测试。
ready=0
for i in $(seq 1 150); do
  if curl -s -m 2 -o /dev/null "$BASE/health"; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "服务在 150 秒内没有就绪。dev 日志尾部："; tail -20 "$DEV_LOG"; exit 1
fi

echo "== 账号准备 =="
curl -s -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-ui' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' >/dev/null
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
UI_PASS=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"UI001"}' | jq -r '.initialPassword')
[ -n "$UI_PASS" ] && [ "$UI_PASS" != null ] || { echo "建学员账号失败"; exit 1; }

# 前置确认：库里确实只有一门课，否则这套用例测的就不是它想测的东西
N=$(curl -s "$BASE/courses" -H "Authorization: Bearer $ADMIN" | jq '.courses | length')
if [ "$N" != "1" ]; then
  echo "库里有 $N 门课，本用例只在单课程下成立，跳过。"; exit 0
fi

echo "== 浏览器检查 =="
UI_BASE="http://127.0.0.1:$PORT" UI_USER=UI001 UI_PASS="$UI_PASS" \
  node test/ui-single-course.mjs
