#!/usr/bin/env bash
# N1 界面检查的启动脚本：备库 → 起服务 → 建账号 → 跑浏览器用例 → 收摊。
set -uo pipefail
cd "$(dirname "$0")/.."

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8797          # 端口表见 CLAUDE.md，8791-8796/8798/8799 已被占用
BASE="http://127.0.0.1:$PORT/api"

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -9 -- -"$SERVER_PGID" 2>/dev/null
  rm -rf .wrangler
  rm -f .dev.vars
}
trap cleanup EXIT

if [ ! -d public ]; then
  echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1
fi

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-uisub
SETUP_TOKEN=test-setup-uisub
ENCRYPTION_KEY=test-encryption-key-uisub
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 \
    || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
F=$(ls seed/*13000-2024-10.sql 2>/dev/null | head -1)
[ -n "$F" ] || { echo "找不到种子，先跑 node scripts/build-seed-sql.mjs"; exit 1; }
npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 启动服务 =="
DEV_LOG=/tmp/ui-subjects-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  if curl -sf -m 2 "$BASE/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }

echo "== 建账号 =="
curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-uisub' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin12345"}' | jq -r '.token')
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"U001","password":"student12345"}'

echo "== 浏览器用例 =="
UI_BASE="http://127.0.0.1:$PORT" UI_USER=U001 UI_PASS=student12345 \
  node test/ui-subjects.mjs
