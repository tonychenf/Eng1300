#!/usr/bin/env bash
# 改进阶段 2 第三期·AI 拆题导入的浏览器检查（PRD 7.1），三种宽度：从「试卷与校对」进去、选照片（当场质检，
# 太小的标红要重拍）、开始、看进度（cron 由测试触发）、逐页核对（可疑处、改题、这页没问题）、入库、AI 出答案。
set -uo pipefail
cd "$(dirname "$0")/.."

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8767          # 端口表见 CLAUDE.md
STUB_PORT=8884
BASE="http://127.0.0.1:$PORT/api"

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -- -"$SERVER_PGID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -f .dev.vars
}
trap cleanup EXIT
[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-uiimp
SETUP_TOKEN=test-setup-uiimp
ENCRYPTION_KEY=test-encryption-key-uiimp
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done

echo "== 启动 AI 替身与服务 =="
node test/ai-stub.mjs "$STUB_PORT" > /tmp/ui-ph2-import-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/ui-ph2-import-dev.log
setsid npx wrangler dev --local --test-scheduled --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1; done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }
curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-uiimp' -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
# 读图用 stub-import（按照片里埋的标记回转写稿），拆题和出答案用 stub-split（文字解析那一档）
curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/PARSING" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "http://127.0.0.1:$STUB_PORT/v1" '{baseUrl:$u,apiKey:"stub-key",model:"stub-import",visionCapable:true,priceInPerM:1,priceOutPerM:2}')"
curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/TEXT_PARSING" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "http://127.0.0.1:$STUB_PORT/v1" '{baseUrl:$u,apiKey:"stub-key",model:"stub-split",priceInPerM:3,priceOutPerM:4}')"

echo "== 浏览器检查 =="
UI_BASE="http://127.0.0.1:$PORT" node test/ui-ph2-import.mjs
