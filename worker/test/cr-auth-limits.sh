#!/usr/bin/env bash
# CR 第一批里改服务端鉴权与限流的几条，共用一次服务启动：
#   M5  拿不准就拒绝（缺课程码由中间件统一 400）
#   M2  重置 / 修改密码、停用之后，旧的登录令牌立即失效
#   M3  登录锁定按「用户名 + 来源 IP」计，别人锁不住你
#   M1  组卷限流（每分钟 / 每 24 小时），阈值是系统参数
#   L3  登录不暴露账号在不在、停没停用（2026-10-07）
#   L2  安全响应头；别的网站不能再从浏览器调接口（2026-10-07）
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
# 本套用自己的本地库目录，自己收摊时不会删掉别的套件的库。**但光这样还不能和别的套件并行**：
# wrangler dev 的打包产物固定写在 worker/.wrangler/tmp，别的套件开头 rm -rf .wrangler 会把它删掉，
# 本套的服务当场卡死（dev 日志报 Could not resolve .../.wrangler/tmp/bundle-.../middleware-loader.entry.ts）。
# 试过一次，就是这么卡住的。要并行就用 test/run-all.sh：它给每套一份自己的 worker 目录（CR-M9）。
PERSIST="$ROOT_DIR/.wrangler-cr-auth"
D1_PERSIST="$PERSIST"
source "$ROOT_DIR/test/lib/d1.sh"   # sql / one / exec_sql（读库失败会在 stderr 报出来）
# 带令牌的请求，返回 HTTP 码，body 落到 $3
code() { curl -s -o "${3:-/dev/null}" -w '%{http_code}' "$BASE$2" -H "Authorization: Bearer $1"; }
login() {   # 用户名 密码 [来源 IP] → 令牌（失败时为空）
  curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    ${3:+-H "CF-Connecting-IP: $3"} -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jq -r '.token // empty'
}

TT=$(mktemp -d)
cleanup() {
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$PERSIST" "$TT"; rm -f "$ROOT_DIR/.dev.vars"
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
npx wrangler d1 execute "$D1_NAME" --local --persist-to "$PERSIST" --file=test/fixtures/publish-all.sql >/dev/null 2>&1

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
echo "== M1：组卷限流，阈值是系统参数 =="
# 默认值是和用户商定的数（每分钟 3 份、24 小时 30 份），迁移 0015 写入
check "默认每分钟上限已由迁移写入" "$(one "SELECT value FROM system_settings WHERE key='limit.exam_per_minute';")" "3"
check "默认 24 小时上限已由迁移写入" "$(one "SELECT value FROM system_settings WHERE key='limit.exam_per_day';")" "30"
gen() {
  curl -s -o /tmp/cr-auth-gen.json -w '%{http_code}' -X POST "$BASE/exams/generate" \
    -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}'
}
exams_of() { one "SELECT COUNT(*) FROM attempts WHERE user_id=$1 AND mode='EXAM';"; }
# 把每分钟上限调小来测，免得为了撞线真组几十份卷；阈值从这里现取，不在断言里写死
PER_MIN=2
sql "UPDATE system_settings SET value='$PER_MIN' WHERE key='limit.exam_per_minute';" >/dev/null
BEFORE=$(exams_of "$SID")
C1=$(gen "$STU"); C2=$(gen "$STU"); C3=$(gen "$STU")
check "上限以内照常组卷" "$C1 $C2" "201 201"
check "一分钟内第 $((PER_MIN + 1)) 份被拒：429" "$C3" "429"
check "  错误码是 rate_limited" "$(jq -r '.error' /tmp/cr-auth-gen.json)" "rate_limited"
check "  提示里的上限就是系统参数里的数" \
  "$(jq -r '.message' /tmp/cr-auth-gen.json | grep -c "每分钟最多 $PER_MIN 份")" "1"
check "被拒的那次没有建出考试记录" "$(exams_of "$SID")" "$((BEFORE + PER_MIN))"
ADMIN_ID=$(one "SELECT id FROM users WHERE username='admin';")
A1=$(gen "$ADMIN"); A2=$(gen "$ADMIN"); A3=$(gen "$ADMIN")
check "管理员不受限（一分钟内连组 3 份）" "$A1 $A2 $A3" "201 201 201"
# 24 小时上限：每分钟放宽，24 小时上限调到刚好等于已组份数
sql "UPDATE system_settings SET value='100' WHERE key='limit.exam_per_minute';" >/dev/null
DONE=$(one "SELECT COUNT(*) FROM attempts WHERE user_id=$SID AND mode='EXAM' AND started_at > datetime('now','-1 day');")
sql "UPDATE system_settings SET value='$DONE' WHERE key='limit.exam_per_day';" >/dev/null
check "24 小时内已组 $DONE 份、上限也是 $DONE：再组被拒" "$(gen "$STU")" "429"
check "  提示说的是 24 小时上限" \
  "$(jq -r '.message' /tmp/cr-auth-gen.json | grep -c "24 小时内最多组 $DONE 份")" "1"
sql "UPDATE system_settings SET value='3' WHERE key='limit.exam_per_minute';" >/dev/null
sql "UPDATE system_settings SET value='30' WHERE key='limit.exam_per_day';" >/dev/null

echo
echo "== M2：重置 / 修改密码、停用之后，旧的登录令牌立即失效 =="
# 第一版只看"账号在不在、停没停用"，重置密码后对方手里的令牌照样能用满 8 小时
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"S102","password":"student12345","subjects":["english"]}'
S102=$(one "SELECT id FROM users WHERE username='S102';")
T1=$(login S102 student12345)
check "登录拿到的令牌可用" "$(code "$T1" /me)" "200"
NEWPW=$(curl -s -X POST "$BASE/admin/users/$S102/reset-password" -H "Authorization: Bearer $ADMIN" | jq -r '.newPassword')
check "管理员重置密码后，重置前的令牌立即失效" "$(code "$T1" /me)" "401"
T2=$(login S102 "$NEWPW")
check "用新密码登录的令牌可用" "$(code "$T2" /me)" "200"
curl -s -o /tmp/cr-auth-pw.json -X POST "$BASE/me/password" -H "Authorization: Bearer $T2" \
  -H 'Content-Type: application/json' -d "{\"currentPassword\":\"$NEWPW\",\"newPassword\":\"changed12345\"}"
T3=$(jq -r '.token // empty' /tmp/cr-auth-pw.json)
check "本人改密码，接口换发了新令牌" "$([ -n "$T3" ] && echo yes || echo no)" "yes"
check "  新令牌可用（本人不会被踢出去）" "$(code "$T3" /me)" "200"
check "  改密码前的令牌失效（别人偷去的那个也一样）" "$(code "$T2" /me)" "401"
curl -s -o /dev/null -X PATCH "$BASE/admin/users/$S102/status" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"disabled":true}'
check "停用后令牌失效" "$(code "$T3" /me)" "401"
curl -s -o /dev/null -X PATCH "$BASE/admin/users/$S102/status" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"disabled":false}'
check "重新启用后，停用前的令牌不会复活" "$(code "$T3" /me)" "401"
check "重新启用后可以重新登录" "$(code "$(login S102 changed12345)" /me)" "200"
# 上线前签发的令牌没有版本号，按 0 算——部署那一刻不能把所有在线的人踢下线。
# S101 从没被重置过，版本号还是 0；用本套的 JWT_SECRET 现签一个不带 tv 的令牌
LEGACY=$(node --input-type=module -e "
  import { SignJWT } from 'jose';
  console.log(await new SignJWT({ username: 'S101', role: 'USER' }).setProtectedHeader({ alg: 'HS256' })
    .setSubject('$SID').setIssuedAt().setExpirationTime('8h')
    .sign(new TextEncoder().encode('test-secret-cr-auth')));")
check "上线前签发、不带版本号的令牌照常可用" "$(code "$LEGACY" /me)" "200"

echo
echo "== M3：登录锁定按「用户名 + 来源 IP」计，别人锁不住你 =="
# 第一版只按用户名计：学号能猜，任何人对着一个账号连错 5 次，这个人就 10 分钟登不进去
login_code() {   # 用户名 密码 来源 IP → HTTP 码
  curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -H "CF-Connecting-IP: $3" -d "{\"username\":\"$1\",\"password\":\"$2\"}"
}
IP_A=203.0.113.10; IP_B=203.0.113.20
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"S103","password":"student12345","subjects":["english"]}'
S103=$(one "SELECT id FROM users WHERE username='S103';")
for i in 1 2 3 4 5; do login_code S103 wrongpass9 "$IP_A" >/dev/null; done
check "IP-A 连错 5 次后，正确密码也被拒" "$(login_code S103 student12345 "$IP_A")" "429"
# 这条同时证明本地服务真的认了我们带的 CF-Connecting-IP——认不了的话下面几条测的就不是 IP
check "  锁住的是「S103|IP-A」这一对" \
  "$(one "SELECT username FROM login_attempts WHERE locked_until IS NOT NULL AND username LIKE 'S103%';")" "S103|$IP_A"
check "同一账号从 IP-B 用正确密码照常能登录" "$(login_code S103 student12345 "$IP_B")" "200"
NEWPW=$(curl -s -X POST "$BASE/admin/users/$S103/reset-password" -H "Authorization: Bearer $ADMIN" | jq -r '.newPassword')
check "管理员重置密码清掉了这个账号在所有 IP 上的计数" \
  "$(one "SELECT COUNT(*) FROM login_attempts WHERE username = 'S103' OR substr(username, 1, 5) = 'S103|';")" "0"
check "  IP-A 随即能用新密码登录" "$(login_code S103 "$NEWPW" "$IP_A")" "200"
BEFORE=$(one "SELECT COUNT(*) FROM login_attempts;")
check "用户名不合规则：401" "$(login_code 'no such user!' whatever1 "$IP_A")" "401"
check "  不合规则的登录不写失败计数（不给人白刷写入额度）" "$(one "SELECT COUNT(*) FROM login_attempts;")" "$BEFORE"
# 重置 admin 密码的流水线（admin-reset.yml → reset-admin-password.sh）清锁定执行的就是 sql/clear-admin-lockout.sql
for i in 1 2 3 4 5; do login_code admin wrongpass9 "$IP_A" >/dev/null; done
check "admin 在 IP-A 被锁" "$(login_code admin admin12345 "$IP_A")" "429"
npx wrangler d1 execute "$D1_NAME" --local --persist-to "$PERSIST" --file=sql/clear-admin-lockout.sql >/dev/null 2>&1
check "跑完流水线清锁那一步，admin 在 IP-A 能登录" "$(login_code admin admin12345 "$IP_A")" "200"

echo
echo "== L3：登录不暴露账号在不在、停没停用（2026-10-07） =="
# 以前：用户名不存在就跳过密码比对，回得明显更快；停用的账号密码随便填都回"已停用"
login_err() {   # 用户名 密码 来源 IP → 错误码
  curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -H "CF-Connecting-IP: $3" \
    -d "{\"username\":\"$1\",\"password\":\"$2\"}" | jq -r '.error // "ok"'
}
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"S104","password":"student12345","subjects":["english"]}'
S104=$(one "SELECT id FROM users WHERE username='S104';")
curl -s -o /dev/null -X PATCH "$BASE/admin/users/$S104/status" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"disabled":true}'
check "停用的账号、密码错：和密码错一样回 invalid_credentials（以前密码随便填都回\"已停用\"）" \
  "$(login_err S104 wrongpass9 203.0.113.40)" "invalid_credentials"
check "停用的账号、密码对：告诉他已停用" "$(login_err S104 student12345 203.0.113.41)" "account_disabled"
# 计时：交替各取 5 次，比中位数。"密码错"那边每次换一个来源 IP，免得撞上锁定（锁定后回得飞快）；
# "不存在"那边每次换一个用户名，道理一样。以前"不存在"回得比"密码错"快一个数量级（不跑密码比对）
t_of() {   # 用户名 密码 来源 IP → 秒
  curl -s -o /dev/null -w '%{time_total}' -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -H "CF-Connecting-IP: $3" -d "{\"username\":\"$1\",\"password\":\"$2\"}"
}
: > "$TT/none"; : > "$TT/wrong"
for i in 1 2 3 4 5; do
  t_of "NOUSER0$i" wrongpass9 203.0.113.50 >> "$TT/none"; echo >> "$TT/none"
  t_of S101 wrongpass9 "203.0.113.6$i" >> "$TT/wrong"; echo >> "$TT/wrong"
done
MED_NONE=$(sort -n "$TT/none" | sed -n 3p); MED_WRONG=$(sort -n "$TT/wrong" | sed -n 3p)
echo "     （中位数：用户名不存在 ${MED_NONE}s，密码错 ${MED_WRONG}s）"
check "用户名不存在和密码错一样慢（不存在的那边至少是密码错那边的一半）" \
  "$(awk -v a="$MED_NONE" -v b="$MED_WRONG" 'BEGIN {print (a >= b / 2) ? "差不多" : "不存在的明显更快"}')" "差不多"

echo
echo "== L2：安全响应头；别的网站不能再从浏览器调接口（2026-10-07） =="
H=$(curl -s -D - -o /dev/null "$BASE/health")
check "接口带 nosniff、不许被嵌框、跳走时不带完整地址" \
  "$(echo "$H" | grep -ci '^x-content-type-options: nosniff')/$(echo "$H" | grep -ci '^x-frame-options: DENY')/$(echo "$H" | grep -ci '^referrer-policy: strict-origin-when-cross-origin')" "1/1/1"
P=$(curl -s -D - -o /dev/null -X OPTIONS "$BASE/auth/login" -H 'Origin: https://evil.example' \
  -H 'Access-Control-Request-Method: POST' -H 'Access-Control-Request-Headers: authorization,content-type')
check "别的网站发来的跨域预检：不给 Access-Control-Allow-Origin（以前是 *，任何网站都能调）" \
  "$(echo "$P" | grep -ci '^access-control-allow-origin')" "0"
check "  跨域的普通请求也不带" \
  "$(curl -s -D - -o /dev/null -H 'Origin: https://evil.example' "$BASE/health" | grep -ci '^access-control-allow-origin')" "0"
SITE="${BASE%/api}"
PAGE=$(curl -s -D - -o /dev/null "$SITE/")
check "页面带 CSP：脚本只认本站、不许被别的网站嵌框" \
  "$(echo "$PAGE" | grep -i '^content-security-policy' | grep -c "script-src 'self'.*frame-ancestors 'none'")/$(echo "$PAGE" | grep -ci '^x-frame-options: DENY')" "1/1"
check "  前端路由回落出来的页面也带（学员直接打开某一页时走的是这条）" \
  "$(curl -s -D - -o /dev/null "$SITE/app/english/wrongbook" | grep -ci '^content-security-policy')" "1"
check "  写响应头的那个文件（_headers）本身不会被下发" \
  "$(curl -s "$SITE/_headers" | grep -c 'Content-Security-Policy')" "0"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
