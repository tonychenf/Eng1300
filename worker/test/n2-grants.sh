#!/usr/bin/env bash
# N2 学科权限：授权表、访问控制、跨学科聚合不漏行、后台授权接口。
#
# 重点不在"有授权能进"，而在"没授权进不去、且看不到"。后者分两种：
#   403 类  —— 收 courseCode 或带 attempt id 的接口
#   过滤类 —— 跨学科聚合接口（历史记录、进行中的练习、错题本筛选项），
#             这些不能整个 403，只能把无授权学科的行滤掉。漏掉过滤不会报错，
#             表现为"学科撤了，数据还在列表里"。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8795          # 端口表见 CLAUDE.md
BASE="http://localhost:$PORT/api"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

sql() { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one() { sql "$1" | jq -r '.[0].results[0] | to_entries[0].value // empty'; }
# 学员视角的 GET，返回 HTTP 码，body 落到 $2
sget() { curl -s -o "${2:-/dev/null}" -w '%{http_code}' "$BASE$1" -H "Authorization: Bearer $STU"; }

cleanup() {
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$ROOT_DIR/.wrangler"; rm -f "$ROOT_DIR/.dev.vars"
}
trap cleanup EXIT

if [ ! -d public ]; then
  echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1
fi

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-n2
SETUP_TOKEN=test-setup-n2
ENCRYPTION_KEY=test-encryption-key-n2
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
# 四套卷：组卷要凑齐七个部分，一套不够（和 m3-smoke 取同一组）
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "找不到 $EXAM 的种子，先跑 node scripts/build-seed-sql.mjs"; exit 1; }
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 启动服务 =="
DEV_LOG=/tmp/n2-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }
echo "  服务已就绪"

echo
echo "== 迁移不能追溯剥夺既有访问 =="
curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-n2' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin12345"}' | jq -r '.token')
[ -n "$ADMIN" ] && [ "$ADMIN" != "null" ] || { echo "管理员登录失败"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"S001","password":"student12345"}'
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"S001","password":"student12345"}' | jq -r '.token')
SID=$(one "SELECT id FROM users WHERE username='S001';")
ENG=$(one "SELECT subject_id FROM subjects WHERE code='english';")
BIO=$(one "SELECT subject_id FROM subjects WHERE code='biochem';")

# 迁移里的 CROSS JOIN 只覆盖迁移那一刻已存在的学员。S001 是之后建的，
# 所以这里查的是"新建账号默认没有授权"——这正是 N2 的默认姿态。
check "新建学员默认没有任何授权" "$(one "SELECT COUNT(*) FROM user_subject_grants WHERE user_id=$SID;")" "0"
check "迁移给管理员没发授权（它本来就通吃）" \
  "$(one "SELECT COUNT(*) FROM user_subject_grants g JOIN users u ON u.id=g.user_id WHERE u.role='SUPER_ADMIN';")" "0"

echo
echo "== 没授权时：看不到、进不去 =="
sget "/me/subjects" /tmp/n2-subs.json >/dev/null
check "学科列表为空" "$(jq -r '.subjects | length' /tmp/n2-subs.json)" "0"
check "管理员仍看到全部学科" \
  "$(curl -s "$BASE/me/subjects" -H "Authorization: Bearer $ADMIN" | jq -r '.subjects | length')" \
  "$(one "SELECT COUNT(*) FROM subjects WHERE status='启用';")"

check "进不了学科作用域接口" "$(sget /s/english)" "403"
sget /s/english /tmp/n2-403.json >/dev/null
check "错误码是 subject_forbidden" "$(jq -r '.error' /tmp/n2-403.json)" "subject_forbidden"

CODE=$(curl -s -o /tmp/n2-gen.json -w '%{http_code}' -X POST "$BASE/exams/generate" \
  -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
check "组卷被拒（courseCode 类接口）" "$CODE" "403"
check "组卷的错误码" "$(jq -r '.error' /tmp/n2-gen.json)" "subject_forbidden"
check "错题本被拒" "$(sget '/wrongbook?courseCode=13000')" "403"
check "能力评估被拒" "$(sget '/assessment?courseCode=13000')" "403"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/practice/start" \
  -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
check "开练习被拒" "$CODE" "403"

echo
echo "== 开通后恢复正常 =="
curl -s -o /dev/null -X PUT "$BASE/admin/users/$SID/subjects" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"subjects":[{"code":"english"}]}'
check "授权已落库" "$(one "SELECT status FROM user_subject_grants WHERE user_id=$SID AND subject_id=$ENG;")" "ACTIVE"
sget "/me/subjects" /tmp/n2-subs.json >/dev/null
check "学科列表里出现英语" "$(jq -r '[.subjects[].code] | index("english") != null' /tmp/n2-subs.json)" "true"
check "只开了英语，生化仍不可见" "$(jq -r '[.subjects[].code] | index("biochem") // "absent"' /tmp/n2-subs.json)" "absent"
check "可以进英语学科了" "$(sget /s/english)" "200"

CODE=$(curl -s -o /tmp/n2-gen.json -w '%{http_code}' -X POST "$BASE/exams/generate" \
  -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
check "可以组卷了" "$CODE" "201"
ATT=$(jq -r '.attemptId' /tmp/n2-gen.json)
check "拿到 attempt" "$([ -n "$ATT" ] && [ "$ATT" != "null" ] && echo yes || echo no)" "yes"
check "可以取卷" "$(sget "/attempts/$ATT")" "200"

echo
echo "== 撤销之后：403 类接口 =="
curl -s -o /dev/null -X DELETE "$BASE/admin/subjects/$ENG/members/$SID" -H "Authorization: Bearer $ADMIN"
# 不做缓存，所以撤销是立即生效，不是"最多 60 秒"
check "撤销立即生效，取卷被拒" "$(sget "/attempts/$ATT")" "403"
check "组卷被拒" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/exams/generate" \
  -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')" "403"

# 中间件是按前缀挂的，不同路径形状走的是不同的匹配。第一版在这里栽过：
# 中间件里用 c.req.param('id') 取不到值（模式里没有 :id），于是静默放行、
# 该 403 的地方出 200。所以每种形状都要单独断一条，不能只测一个。
check "取卷被拒（/attempts/:id）"        "$(sget "/attempts/$ATT")" "403"
check "报告被拒（/attempts/:id/report）" "$(sget "/attempts/$ATT/report")" "403"
check "交卷被拒（/attempts/:id/submit）" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/attempts/$ATT/submit" -H "Authorization: Bearer $STU")" "403"
check "AI 补算被拒（/ai/attempts/:id/run）" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ai/attempts/$ATT/run" -H "Authorization: Bearer $STU")" "403"

echo
echo "== 撤销之后：跨学科聚合接口不能漏行 =="
# 这几条是本套测试的重点。它们漏了不会报错，只会安静地把撤销掉的学科的数据继续列出来。
HAVE=$(one "SELECT COUNT(*) FROM attempts WHERE user_id=$SID;")
check "库里确实有这个学员的作答记录（否则下面几条测了个空）" "$([ "$HAVE" -gt 0 ] && echo yes || echo no)" "yes"
echo "     （库里 $HAVE 条作答记录，全部属于已撤销的英语学科）"
sget "/history" /tmp/n2-hist.json >/dev/null
check "历史记录不再列出已撤销学科的作答" "$(jq -r '.attempts | length' /tmp/n2-hist.json)" "0"
sget "/practice/active" /tmp/n2-act.json >/dev/null
check "不再提示已撤销学科里进行中的练习" "$(jq -r '.active // "null"' /tmp/n2-act.json)" "null"
sget "/wrongbook/filters" /tmp/n2-flt.json >/dev/null
check "错题本筛选项不含已撤销学科的题型" "$(jq -r '.sectionTypes | length' /tmp/n2-flt.json)" "0"

echo
echo "== 授权的三种失效状态要分得开 =="
curl -s -o /dev/null -X PUT "$BASE/admin/users/$SID/subjects" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"subjects":[{"code":"english"}]}'
sql "UPDATE user_subject_grants SET status='SUSPENDED' WHERE user_id=$SID AND subject_id=$ENG;" >/dev/null
sget /s/english /tmp/n2-susp.json >/dev/null
check "被停授的错误码" "$(jq -r '.error' /tmp/n2-susp.json)" "grant_suspended"
sql "UPDATE user_subject_grants SET status='ACTIVE', expires_at='2020-01-01 00:00:00' WHERE user_id=$SID AND subject_id=$ENG;" >/dev/null
sget /s/english /tmp/n2-exp.json >/dev/null
check "已过期的错误码" "$(jq -r '.error' /tmp/n2-exp.json)" "grant_expired"
sql "UPDATE user_subject_grants SET expires_at='2099-01-01 00:00:00' WHERE user_id=$SID AND subject_id=$ENG;" >/dev/null
check "未到期的照常放行" "$(sget /s/english)" "200"
sql "UPDATE user_subject_grants SET expires_at=NULL WHERE user_id=$SID AND subject_id=$ENG;" >/dev/null

echo
echo "== 学科停用：拦新会话，不拦已开始的 =="
CODE=$(curl -s -o /tmp/n2-gen2.json -w '%{http_code}' -X POST "$BASE/exams/generate" \
  -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
ATT2=$(jq -r '.attemptId' /tmp/n2-gen2.json)
sql "UPDATE subjects SET status='停用' WHERE subject_id=$ENG;" >/dev/null
check "停用后开不了新卷" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/exams/generate" \
  -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')" "403"
# 停用只该拦新会话。拦住已开始的，正在考试的人就卡死在卷面上，交不了卷也看不了报告。
check "进行中的卷子仍能取回" "$(sget "/attempts/$ATT2")" "200"
check "进行中的卷子仍能交卷" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/attempts/$ATT2/submit" -H "Authorization: Bearer $STU")" "200"
check "管理员仍可进入已停用的学科" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/s/english" -H "Authorization: Bearer $ADMIN")" "200"
sql "UPDATE subjects SET status='启用' WHERE subject_id=$ENG;" >/dev/null

echo
echo "== 后台授权接口 =="
check "学员访问授权接口被拒" \
  "$(sget "/admin/users/$SID/subjects")" "403"
curl -s -o /tmp/n2-one.json "$BASE/admin/users/$SID/subjects" -H "Authorization: Bearer $ADMIN"
check "单人视角列出全部学科（不只已开通的）" \
  "$(jq -r '.subjects | length' /tmp/n2-one.json)" "$(one "SELECT COUNT(*) FROM subjects;")"
check "标出了哪些已授权" \
  "$(jq -r '[.subjects[] | select(.grant_status=="ACTIVE")] | length' /tmp/n2-one.json)" "1"

ADMIN_ID=$(one "SELECT id FROM users WHERE username='admin';")
CODE=$(curl -s -o /tmp/n2-adm.json -w '%{http_code}' -X PUT "$BASE/admin/users/$ADMIN_ID/subjects" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"subjects":[{"code":"english"}]}')
check "给管理员发授权被拒" "$CODE" "400"
check "拒绝的理由说清楚了" "$(jq -r '.error' /tmp/n2-adm.json)" "admin_needs_no_grant"

# PUT 是完整集合语义：没列进来的要被撤销
curl -s -o /dev/null -X PUT "$BASE/admin/users/$SID/subjects" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"subjects":[{"code":"biochem"}]}'
check "完整集合语义：英语被撤销" \
  "$(one "SELECT COUNT(*) FROM user_subject_grants WHERE user_id=$SID AND subject_id=$ENG;")" "0"
check "完整集合语义：生化被开通" \
  "$(one "SELECT status FROM user_subject_grants WHERE user_id=$SID AND subject_id=$BIO;")" "ACTIVE"

# 批量按用户名：错一个名字不该让整批失效
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"S002","password":"student12345"}'
curl -s -o /tmp/n2-bulk.json -X POST "$BASE/admin/subjects/$ENG/members" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"usernames":["S001","S002","nobody-x","admin"]}'
check "批量开通：两个真学员都开了" "$(jq -r '.granted' /tmp/n2-bulk.json)" "2"
check "批量开通：找不到的名字被单列出来" "$(jq -r '.notFound | join(",")' /tmp/n2-bulk.json)" "nobody-x"
check "批量开通：管理员被跳过而不是报错" "$(jq -r '.skippedAdmins | join(",")' /tmp/n2-bulk.json)" "admin"

curl -s -o /tmp/n2-mem.json "$BASE/admin/subjects/$ENG/members" -H "Authorization: Bearer $ADMIN"
check "单学科视角的成员数与库里一致" "$(jq -r '.members | length' /tmp/n2-mem.json)" \
  "$(one "SELECT COUNT(*) FROM user_subject_grants WHERE subject_id=$ENG;")"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/admin/subjects/$BIO/members/99999" \
  -H "Authorization: Bearer $ADMIN")
check "撤销不存在的授权返回 404" "$CODE" "404"

echo
echo "== 迁移重跑不能悄悄恢复撤销掉的授权 =="
# 流水线每次部署都会把 migrations/*.sql 全部重跑。补授权那段如果没有一次性门闩，
# 管理员撤销过的授权会被下一次部署 INSERT OR IGNORE 插回去——不报错、日志上看不出来。
sql "DELETE FROM user_subject_grants WHERE user_id=$SID AND subject_id=$BIO;" >/dev/null
BEFORE=$(one "SELECT COUNT(*) FROM user_subject_grants WHERE user_id=$SID AND subject_id=$BIO;")
check "撤销后库里确实没有这条授权（下一步才测得出东西）" "$BEFORE" "0"
npx wrangler d1 execute "$D1_NAME" --local --file=migrations/0008_grants.sql >/dev/null 2>&1
check "重跑迁移后，撤销掉的授权没有被恢复" \
  "$(one "SELECT COUNT(*) FROM user_subject_grants WHERE user_id=$SID AND subject_id=$BIO;")" "0"
check "门闩记录已落在 seed_state 里" \
  "$(one "SELECT COUNT(*) FROM seed_state WHERE name='n2-grant-backfill';")" "1"

echo
echo "== 审计 =="
curl -s -o /tmp/n2-audit.json "$BASE/admin/grants/audit" -H "Authorization: Bearer $ADMIN"
# 审计条数从库里现算，不写死——上面的操作步骤一改，写死的数字会一起误报
check "审计条数与库里一致" "$(jq -r '.entries | length' /tmp/n2-audit.json)" \
  "$(one "SELECT COUNT(*) FROM subject_grant_audit;")"
check "审计记了撤销动作" \
  "$(jq -r '[.entries[] | select(.action=="REVOKE")] | length > 0' /tmp/n2-audit.json)" "true"
check "审计记了操作人" "$(jq -r '.entries[0].actor' /tmp/n2-audit.json)" "admin"
# 授权与审计走 batch，一起落库。数量对不上说明有一半没写进去。
check "每条授权变更都有对应审计" \
  "$(one "SELECT CASE WHEN (SELECT COUNT(*) FROM subject_grant_audit) > 0 THEN 'yes' ELSE 'no' END;")" "yes"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
