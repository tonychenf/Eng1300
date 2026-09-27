#!/usr/bin/env bash
# CR 第一批里改服务端鉴权与限流的几条，共用一次服务启动：
#   M5  拿不准就拒绝（缺课程码由中间件统一 400）
#   M2  重置 / 修改密码、停用之后，旧的登录令牌立即失效
#   M3  登录锁定按「用户名 + 来源 IP」计，别人锁不住你
#   M1  组卷限流（每分钟 / 每 24 小时），阈值是系统参数
# 查库出错不该被当成"未登录"那条（M5 后半）在 test/auth-guard.test.mjs，那条要替身才测得到。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8778          # 端口表见 CLAUDE.md
BASE="http://localhost:$PORT/api"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
# 本套用自己的本地库目录，自己收摊时不会删掉别的套件的库。**但仍然不能和别的套件并行**：
# wrangler dev 的打包产物固定写在 worker/.wrangler/tmp，别的套件开头 rm -rf .wrangler 会把它删掉，
# 本套的服务当场卡死（dev 日志报 Could not resolve .../.wrangler/tmp/bundle-.../middleware-loader.entry.ts）。
# 试过一次，就是这么卡住的；要真并行得把这个目录也隔开（CR-M9）。
PERSIST="$ROOT_DIR/.wrangler-cr-auth"
sql() { npx wrangler d1 execute "$D1_NAME" --local --persist-to "$PERSIST" --json --command "$1" 2>/dev/null; }
one() { sql "$1" | jq -r '.[0].results[0] | to_entries[0].value // empty'; }
# 带令牌的请求，返回 HTTP 码，body 落到 $3
code() { curl -s -o "${3:-/dev/null}" -w '%{http_code}' "$BASE$2" -H "Authorization: Bearer $1"; }
login() {   # 用户名 密码 [来源 IP] → 令牌（失败时为空）
  curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    ${3:+-H "CF-Connecting-IP: $3"} -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jq -r '.token // empty'
}

cleanup() {
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$PERSIST"; rm -f "$ROOT_DIR/.dev.vars"
}
trap cleanup EXIT

if [ ! -d public ]; then
  echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1
fi

echo "== 准备本地数据库 =="
rm -rf "$PERSIST"
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-cr-auth
SETUP_TOKEN=test-setup-cr-auth
ENCRYPTION_KEY=test-encryption-key-cr-auth
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --persist-to "$PERSIST" --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --persist-to "$PERSIST" --file=seed/english-000-knowledge-points.sql >/dev/null 2>&1
# 四套卷：组卷要凑齐七个部分，一套不够（和 n2-grants 取同一组）
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "找不到 $EXAM 的种子，先跑 node scripts/build-seed-sql.mjs"; exit 1; }
  npx wrangler d1 execute "$D1_NAME" --local --persist-to "$PERSIST" --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --persist-to "$PERSIST" --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 启动服务 =="
DEV_LOG=/tmp/cr-auth-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --persist-to "$PERSIST" --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }
echo "  服务已就绪"

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-cr-auth' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(login admin admin12345)
[ -n "$ADMIN" ] || { echo "管理员登录失败"; exit 1; }
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"S101","password":"student12345","subjects":["english"]}'
STU=$(login S101 student12345)
[ -n "$STU" ] || { echo "学员登录失败"; exit 1; }
SID=$(one "SELECT id FROM users WHERE username='S101';")

echo
echo "== M5：需要课程码的接口，缺了由中间件统一 400 =="
# 第一版中间件拿不到课程码就放行、指望接口自己报 400；/practice/section-types 就没报，
# 缺参数时一路走到 loadPackByCourse(undefined) 报 500。
CODE=$(code "$STU" "/practice/section-types" /tmp/cr-auth-st.json)
check "开练习的题型清单缺课程码：400（原来 500）" "$CODE" "400"
check "  错误码是 invalid_request" "$(jq -r '.error' /tmp/cr-auth-st.json)" "invalid_request"
# 错题本列表是唯一允许不带课程码的：不带时跨学科、按授权滤行（CR-H1）。改严了会误伤它
check "错题本列表不带课程码仍然可用" "$(code "$STU" "/wrongbook")" "200"
check "带课程码的正常请求不受影响" "$(code "$STU" "/practice/section-types?courseCode=13000")" "200"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
