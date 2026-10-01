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

source "$ROOT_DIR/test/lib/d1.sh"   # sql / one / exec_sql（读库失败会在 stderr 报出来）
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
npx wrangler d1 execute "$D1_NAME" --local --file=seed/english-000-knowledge-points.sql >/dev/null 2>&1
# 四套卷：组卷要凑齐七个部分，一套不够（和 m3-smoke 取同一组）
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "找不到 $EXAM 的种子，先跑 node scripts/build-seed-sql.mjs"; exit 1; }
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=test/fixtures/publish-all.sql >/dev/null 2>&1

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
echo "== 建号时一并开通学科 =="
# 默认没授权是对的，但"建完就能用"是绝大多数场景，六套既有测试也都靠它。
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"S010","password":"student12345","subjects":["english"]}'
S010=$(one "SELECT id FROM users WHERE username='S010';")
check "建号时带 subjects，授权直接落库" \
  "$(one "SELECT COUNT(*) FROM user_subject_grants WHERE user_id=$S010 AND subject_id=$ENG AND status='ACTIVE';")" "1"
check "只开了传进来的那个，没有多开" \
  "$(one "SELECT COUNT(*) FROM user_subject_grants WHERE user_id=$S010;")" "1"
check "建号的授权也进了审计" \
  "$(one "SELECT COUNT(*) FROM subject_grant_audit WHERE target_user_id=$S010 AND action='GRANT';")" "1"

# 学科码打错要整个失败，不能静默跳过——跳过的结果是"号建出来了、学科没开"，
# 跟管理员忘了第二步一模一样，而且不报错。
BEFORE_N=$(one "SELECT COUNT(*) FROM users;")
CODE=$(curl -s -o /tmp/n2-badsub.json -w '%{http_code}' -X POST "$BASE/admin/users" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"username":"S011","subjects":["english","nosuchsubject"]}')
check "学科码打错，建号被拒" "$CODE" "404"
check "拒绝的理由说清楚了" "$(jq -r '.error' /tmp/n2-badsub.json)" "subject_not_found"
# 这条才是重点：错误码对了但号已经建出来，等于留下一个打不开任何东西的废账号
check "被拒时账号没有建出来" "$(one "SELECT COUNT(*) FROM users;")" "$BEFORE_N"

# 建号与授权分成两段 try，重名这条容易在重构里被连带改坏：
# 授权那边万一报 UNIQUE，会被误判成"用户名已存在"，而号其实建好了。
CODE=$(curl -s -o /tmp/n2-dup.json -w '%{http_code}' -X POST "$BASE/admin/users" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"username":"S010","subjects":["english"]}')
check "重名建号仍返回 409" "$CODE" "409"
check "重名的错误码" "$(jq -r '.error' /tmp/n2-dup.json)" "username_taken"

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

# 请求体里的课程码写成数字（CR-H1）：第一版的中间件只认字符串，认不出就当成"没传"，
# 连授权检查都跳过了——后面查课程恰好会失败，所以没建出东西，但检查本身是跳过的。
for EP in /exams/generate /practice/start /practice/drill /ai/assessment; do
  CODE=$(curl -s -o /tmp/n2-num.json -w '%{http_code}' -X POST "$BASE$EP" \
    -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' \
    -d '{"courseCode":13000,"tagId":"any"}')
  check "课程码写成数字被拒（$EP）" "$CODE" "400"
done
check "  错误码是 invalid_request" "$(jq -r '.error' /tmp/n2-num.json)" "invalid_request"

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
echo "== 课程码只认一个来源（CR-H1）=="
# 第一版的中间件"网址里有就用网址的"，而收请求体的四个接口只读请求体：网址写有授权的课、
# 请求体写没授权的课，中间件查前者、接口用后者，只授权生化的学员照样建出了英语的考试和练习。
# 攻击目标选英语，是因为本套测试里只有英语有题：换成没题的学科，第一版也只会因为没题 422，
# "绕过去了"这件事在库里看不出来。
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"S020","password":"student12345","subjects":["biochem"]}'
S020=$(one "SELECT id FROM users WHERE username='S020';")
BIOSTU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"S020","password":"student12345"}' | jq -r '.token')
check "S020 只授权了生化" \
  "$(one "SELECT group_concat(s.code) FROM user_subject_grants g JOIN subjects s ON s.subject_id=g.subject_id WHERE g.user_id=$S020;")" "biochem"
# 专项练习要一个英语里真有已发布题的考点，否则第一版在那条路径上也只会 422
DRILL_TAG=$(one "SELECT x.tag_id FROM question_knowledge_points x JOIN questions q ON q.question_id=x.question_id
                  WHERE q.course_code='13000' AND q.status='已发布' GROUP BY x.tag_id ORDER BY COUNT(*) DESC LIMIT 1;")
echo "     专项练习用的英语考点：$DRILL_TAG（已发布题 $(one "SELECT COUNT(*) FROM question_knowledge_points x
  JOIN questions q ON q.question_id=x.question_id WHERE x.tag_id='$DRILL_TAG' AND q.status='已发布';") 道）"
for EP in /exams/generate /practice/start /practice/drill /ai/assessment; do
  CODE=$(curl -s -o /tmp/n2-mis.json -w '%{http_code}' -X POST "$BASE$EP?courseCode=biochem-main" \
    -H "Authorization: Bearer $BIOSTU" -H 'Content-Type: application/json' \
    -d "{\"courseCode\":\"13000\",\"tagId\":\"$DRILL_TAG\"}")
  check "网址与请求体的课程码不一致被拒（$EP）" "$CODE" "400"
  check "  错误码是 course_code_mismatch（$EP）" "$(jq -r '.error' /tmp/n2-mis.json)" "course_code_mismatch"
done
check "只授权生化的学员名下没有英语的会话" \
  "$(one "SELECT COUNT(*) FROM attempts WHERE user_id=$S020 AND course_code='13000';")" "0"

# 正常请求不能被误伤：两处都写、写的是同一门课，照常放行。
# 这一步顺带给 S001 留下一个进行中的英语练习，下面「进行中的练习不漏行」要靠它才测得到东西。
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/practice/start?courseCode=13000" \
  -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
check "网址与请求体一致时照常放行" "$CODE" "201"

# 造错题：交一份故意答错的卷子。下面「错题本不漏行」两条要靠它——学员一道错题都没有时，
# 过滤不过滤结果都是 0，断言就成了装饰（第一版的「筛选项」那条就是这样一直空转的）。
curl -s -o /tmp/n2-genw.json -X POST "$BASE/exams/generate" \
  -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}'
ATTW=$(jq -r '.attemptId' /tmp/n2-genw.json)
for QID in $(sql "SELECT question_id FROM attempt_questions WHERE attempt_id='$ATTW' ORDER BY ord LIMIT 3;" \
             | jq -r '.[0].results[].question_id'); do
  curl -s -o /dev/null -X PUT "$BASE/attempts/$ATTW/answers" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d "{\"questionId\":\"$QID\",\"answer\":\"Z\"}"
done
curl -s -o /dev/null -X POST "$BASE/attempts/$ATTW/submit" -H "Authorization: Bearer $STU"

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
WRONG=$(one "SELECT COUNT(*) FROM wrong_items WHERE user_id=$SID;")
check "库里确实有这个学员的错题（否则错题本那两条测了个空）" "$([ "${WRONG:-0}" -gt 0 ] && echo yes || echo no)" "yes"
ACTIVE=$(one "SELECT COUNT(*) FROM attempts WHERE user_id=$SID AND mode='PRACTICE' AND status='进行中';")
check "库里确实有这个学员进行中的练习（否则那条测了个空）" "$([ "${ACTIVE:-0}" -gt 0 ] && echo yes || echo no)" "yes"
sget "/history" /tmp/n2-hist.json >/dev/null
check "历史记录不再列出已撤销学科的作答" "$(jq -r '.attempts | length' /tmp/n2-hist.json)" "0"
sget "/practice/active" /tmp/n2-act.json >/dev/null
check "不再提示已撤销学科里进行中的练习" "$(jq -r '.active // "null"' /tmp/n2-act.json)" "null"
sget "/wrongbook/filters" /tmp/n2-flt.json >/dev/null
check "错题本筛选项不含已撤销学科的题型" "$(jq -r '.sectionTypes | length' /tmp/n2-flt.json)" "0"
# 不带课程码的错题本列表（CR-H1）：带课程码是 403、筛选项也滤了，第一版唯独这里漏了，
# 撤销之后把那个学科的错题连同题干、答案、解析原样列出来
sget "/wrongbook" /tmp/n2-wb.json >/dev/null
check "错题本不带课程码时也不列出已撤销学科的错题" "$(jq -r '.total' /tmp/n2-wb.json)" "0"

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
echo "== 到期日按北京时间那一天结束（CR-M7） =="
# 以前后台发 "日期 23:59:59"、原样存，被当成世界时比——选 10 月 1 日到期，北京时间 10 月 2 日早上 8 点才失效。
# 现在存那一天北京时间 23:59:59 对应的世界时（同一天 15:59:59）。日期从北京时间现算，不写死。
BJ_TODAY=$(TZ=Asia/Shanghai date +%F)
BJ_YESTERDAY=$(TZ=Asia/Shanghai date -d '-1 day' +%F)
put_exp() {
  curl -s -o /tmp/n2-pe.json -w '%{http_code}' -X PUT "$BASE/admin/users/$SID/subjects" \
    -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
    -d "{\"subjects\":[{\"code\":\"english\",\"expiresAt\":$1}]}"
}
stored_exp() { one "SELECT expires_at FROM user_subject_grants WHERE user_id=$SID AND subject_id=$ENG;"; }
check "按人设今天（北京时间）到期：存的是今天北京时间 23:59:59 对应的世界时" \
  "$(put_exp "\"$BJ_TODAY\"")/$(stored_exp)" "200/$BJ_TODAY 15:59:59"
check "  今天之内照常放行" "$(sget /s/english)" "200"
check "设昨天（北京时间）到期：已经失效" "$(put_exp "\"$BJ_YESTERDAY\"")/$(sget /s/english)" "200/403"
check "旧页面发来的「日期 23:59:59」也按北京时间理解" \
  "$(put_exp "\"$BJ_TODAY 23:59:59\"")/$(stored_exp)" "200/$BJ_TODAY 15:59:59"
check "不存在的日期：400，库里不动" \
  "$(put_exp '"2026-02-30"')/$(jq -r '.error' /tmp/n2-pe.json)/$(stored_exp)" "400/invalid_expires_at/$BJ_TODAY 15:59:59"
check "看不懂的写法：400" "$(put_exp '"下个月"')" "400"
CODE=$(curl -s -o /tmp/n2-pm.json -w '%{http_code}' -X POST "$BASE/admin/subjects/$ENG/members" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d "{\"usernames\":[\"S001\"],\"expiresAt\":\"$BJ_TODAY\"}")
check "按学科批量开通也一样换算" "$CODE/$(stored_exp)" "200/$BJ_TODAY 15:59:59"
CODE=$(curl -s -o /tmp/n2-pm.json -w '%{http_code}' -X POST "$BASE/admin/subjects/$ENG/members" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"usernames":["S001"],"expiresAt":"2026-13-01"}')
check "  写错的日期同样 400" "$CODE" "400"
sql "UPDATE user_subject_grants SET expires_at='2020-01-01 15:59:59' WHERE user_id=$SID AND subject_id=$ENG;" >/dev/null
sget /s/english /tmp/n2-exp2.json >/dev/null
check "到期提示里的时间是北京时间（2020-01-01 23:59，不是 15:59:59）" \
  "$(jq -r '.message' /tmp/n2-exp2.json | grep -c '已于 2020-01-01 23:59 到期')" "1"

# 存量换算（migrations/0016）：只换"日期 23:59:59"这种旧页面写出来的形状，只换一次
sql "UPDATE user_subject_grants SET expires_at='2099-03-01 23:59:59' WHERE user_id=$SID AND subject_id=$ENG;" >/dev/null
exec_sql "DELETE FROM seed_state WHERE name = 'm7-grant-expiry-beijing';"
npx wrangler d1 execute "$D1_NAME" --local --file=migrations/0016_grant_expiry_beijing.sql > /tmp/n2-m7.log 2>&1 \
  || { echo "  !! 0016 执行失败：$(tail -3 /tmp/n2-m7.log)"; }
check "存量的「日期 23:59:59」换成那一天北京时间结束的世界时" "$(stored_exp)" "2099-03-01 15:59:59"
sql "UPDATE user_subject_grants SET expires_at='2099-04-01 23:59:59' WHERE user_id=$SID AND subject_id=$ENG;" >/dev/null
npx wrangler d1 execute "$D1_NAME" --local --file=migrations/0016_grant_expiry_beijing.sql > /tmp/n2-m7.log 2>&1
check "  只换一次：门闩合上之后，下一次部署重跑不再动它" "$(stored_exp)" "2099-04-01 23:59:59"
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
