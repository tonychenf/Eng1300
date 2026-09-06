#!/usr/bin/env bash
# M2 后端冒烟测试：题库接口、校对流程、发布门槛、AI配置、限流。
# 用临时的本地 D1 跑，跑完自动清理，不影响真实数据。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=8791
BASE="http://localhost:$PORT/api"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc";
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

sql() { npx wrangler d1 execute eng1300-mvp --local --json --command "$1" 2>/dev/null; }

cleanup() {
  # wrangler dev 会派生 workerd 子进程，只杀 wrangler 本身杀不掉它，
  # 它会继续占着端口，下一轮测试就起不来（报 Address already in use，
  # 同时还会一直提示一个已被删掉的构建临时路径，很容易看岔）。
  # 所以用 setsid 让它自成进程组，退出时整组一起杀。
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$ROOT_DIR/.wrangler"
  rm -f "$ROOT_DIR/.dev.vars.test"
}
trap cleanup EXIT

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'EOF'
JWT_SECRET=test-secret-m2
SETUP_TOKEN=test-setup-m2
ENCRYPTION_KEY=test-encryption-key-m2
EOF
for m in migrations/0001_init.sql migrations/0002_bank.sql migrations/0003_security.sql \
         migrations/0004_merge_courses.sql; do
  npx wrangler d1 execute eng1300-mvp --local --file="$m" >/dev/null 2>&1
done
# 只导入两套卷，够测流程且启动快
npx wrangler d1 execute eng1300-mvp --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2024-04 13000-2024-10; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  if [ -z "$F" ]; then
    echo "找不到 $EXAM 的种子文件，请先运行 node scripts/build-seed-sql.mjs"; exit 1
  fi
  npx wrangler d1 execute eng1300-mvp --local --file="$F" >/dev/null 2>&1 \
    || { echo "导入 $F 失败"; exit 1; }
done

echo "== 启动服务 =="
DEV_LOG=/tmp/m2-dev.log
# 等端口彻底释放再起，免得撞上上一轮残留的 workerd
for i in $(seq 1 20); do
  ss -ltn 2>/dev/null | grep -q ":$PORT " || break
  sleep 1
done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PID=$!
SERVER_PGID=$SERVER_PID
# wrangler dev 启动时会去连几个 cloudflare.com 的地址，本环境的出站策略拒绝了它们，
# 它要重试到超时才继续，因此启动可能要一分多钟。等不够久就会拿一个没起来的服务
# 跑完整轮测试，出一堆看不懂的失败——所以这里等足，等不到就带日志报错退出。
ready=0
for i in $(seq 1 150); do
  if curl -s -m 2 -o /dev/null "$BASE/health"; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "服务在 150 秒内没有就绪，测试无法继续。dev 日志尾部："
  tail -20 "$DEV_LOG" 2>/dev/null
  exit 1
fi

echo "== 初始化与登录 =="
curl -s -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-m2' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' >/dev/null
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
check "超级管理员登录拿到token" "$([ -n "$ADMIN" ] && [ "$ADMIN" != "null" ] && echo yes)" "yes"

STU_PASS=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"T001"}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"T001\",\"password\":\"$STU_PASS\"}" | jq -r '.token')

echo "== 题库接口 =="
CODE=$(curl -s -o /tmp/stats.json -w '%{http_code}' "$BASE/admin/bank/stats" -H "Authorization: Bearer $ADMIN")
check "题库统计返回200" "$CODE" "200"
# 00015 与 13000 已合并为一门课，两套卷都挂在 13000 下
check "统计只剩合并后的一门课程" "$(jq '.byCourse | length' /tmp/stats.json)" "1"
check "两套卷都归到 13000" "$(jq -r '.byCourse[0].exam_count' /tmp/stats.json)" "2"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/bank/stats" -H "Authorization: Bearer $STU")
check "普通用户访问题库统计被拒(403)" "$CODE" "403"

curl -s "$BASE/admin/bank/exams" -H "Authorization: Bearer $ADMIN" > /tmp/exams.json
check "试卷列表返回2套" "$(jq '.exams | length' /tmp/exams.json)" "2"

curl -s "$BASE/admin/bank/exams/00015-2024-04" -H "Authorization: Bearer $ADMIN" > /tmp/exam.json
check "整卷详情含7个部分" "$(jq '.sections | length' /tmp/exam.json)" "7"
check "整卷详情含51题" "$(jq '[.sections[].questions[]] | length' /tmp/exam.json)" "51"
check "第1题选项已解析为数组" "$(jq -r '.sections[0].questions[0].options | type' /tmp/exam.json)" "array"
check "第1题带考点标签" "$(jq -r '.sections[0].questions[0].knowledgePoints[0]' /tmp/exam.json)" "阅读细节定位"

echo "== 校对与发布门槛 =="
NOTES=$(jq '.parsingNotes | length' /tmp/exam.json)
check "存疑记录已入库" "$([ "$NOTES" -gt 0 ] && echo yes)" "yes"

CODE=$(curl -s -o /tmp/pub.json -w '%{http_code}' -X POST \
  "$BASE/admin/bank/exams/00015-2024-04/publish" -H "Authorization: Bearer $ADMIN")
check "存疑未处理时发布被拦截(422)" "$CODE" "422"

# 逐条处理存疑记录
for id in $(jq -r '.parsingNotes[].id' /tmp/exam.json); do
  curl -s -X PATCH "$BASE/admin/bank/notes/$id" -H "Authorization: Bearer $ADMIN" \
    -H 'Content-Type: application/json' -d '{"resolved":true}' >/dev/null
done

# 种子里已经有一批被解析存疑记录点名的题，先数清楚再手动多标一道，
# 期望值按实际算——写死 50/1 的话，存疑规则一变这条就误报。
HELD_BEFORE=$(sql "SELECT COUNT(*) AS n FROM questions WHERE exam_id='00015-2024-04' AND status='存疑';" | jq -r '.[0].results[0].n')
TOTAL_Q=$(sql "SELECT COUNT(*) AS n FROM questions WHERE exam_id='00015-2024-04';" | jq -r '.[0].results[0].n')
MANUAL_Q=$(sql "SELECT question_id AS q FROM questions WHERE exam_id='00015-2024-04' AND status!='存疑' ORDER BY ord LIMIT 1;" | jq -r '.[0].results[0].q')
curl -s -X PATCH "$BASE/admin/bank/questions/$MANUAL_Q" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"status":"存疑"}' >/dev/null
EXPECT_HELD=$((HELD_BEFORE + 1))
EXPECT_PUB=$((TOTAL_Q - EXPECT_HELD))
echo "     （本卷共 $TOTAL_Q 题，存疑 $EXPECT_HELD 题，应发布 $EXPECT_PUB 题）"

CODE=$(curl -s -o /tmp/pub.json -w '%{http_code}' -X POST \
  "$BASE/admin/bank/exams/00015-2024-04/publish" -H "Authorization: Bearer $ADMIN")
check "处理完存疑后可发布(200)" "$CODE" "200"
check "发布数量等于总题数减存疑数" "$(jq -r '.published' /tmp/pub.json)" "$EXPECT_PUB"
check "存疑题全部保留未发布" "$(jq -r '.held' /tmp/pub.json)" "$EXPECT_HELD"

echo "== 校对修改落库 =="
curl -s -X PATCH "$BASE/admin/bank/questions/00015-2024-04-q2" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"stem":"修改后的题干","answer":"C","knowledgePoints":["阅读推理判断","全新考点"],"reviewed":true}' >/dev/null
curl -s "$BASE/admin/bank/exams/00015-2024-04" -H "Authorization: Bearer $ADMIN" > /tmp/exam2.json
check "题干修改已保存" "$(jq -r '[.sections[].questions[] | select(.question_id=="00015-2024-04-q2")][0].stem' /tmp/exam2.json)" "修改后的题干"
check "答案修改已保存" "$(jq -r '[.sections[].questions[] | select(.question_id=="00015-2024-04-q2")][0].answer' /tmp/exam2.json)" "C"
check "新考点标签自动创建" "$(jq -r '[.sections[].questions[] | select(.question_id=="00015-2024-04-q2")][0].knowledgePoints | contains(["全新考点"])' /tmp/exam2.json)" "true"

echo "== 课程与已发布计数 =="
curl -s "$BASE/courses" -H "Authorization: Bearer $STU" > /tmp/courses.json
check "普通用户可读课程列表" "$(jq '.courses | length' /tmp/courses.json)" "1"
check "课程已发布题数与发布结果一致" "$(jq -r '.courses[] | select(.course_code=="13000") | .published_questions' /tmp/courses.json)" "$EXPECT_PUB"

echo "== AI 配置 =="
curl -s -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"baseUrl":"https://api.siliconflow.cn/v1","apiKey":"sk-test-secret-value-123456","model":"Qwen/Qwen3-8B"}' >/dev/null
curl -s "$BASE/admin/ai/settings" -H "Authorization: Bearer $ADMIN" > /tmp/ai.json
check "AI配置已保存" "$(jq -r '.settings.TUTORING.model' /tmp/ai.json)" "Qwen/Qwen3-8B"
check "Key以脱敏形式返回" "$(jq -r '.settings.TUTORING.apiKeyMasked' /tmp/ai.json)" "sk-****3456"
check "响应中不含明文Key" "$(grep -c 'sk-test-secret-value-123456' /tmp/ai.json || true)" "0"

CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/ai/settings" -H "Authorization: Bearer $STU")
check "普通用户读AI配置被拒(403)" "$CODE" "403"

# 不带 apiKey 的更新应保留原 Key
curl -s -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"model":"Qwen/Qwen3-14B"}' >/dev/null
curl -s "$BASE/admin/ai/settings" -H "Authorization: Bearer $ADMIN" > /tmp/ai2.json
check "改模型不清空原Key" "$(jq -r '.settings.TUTORING.apiKeyMasked' /tmp/ai2.json)" "sk-****3456"
check "模型已更新" "$(jq -r '.settings.TUTORING.model' /tmp/ai2.json)" "Qwen/Qwen3-14B"

echo "== 系统参数 =="
curl -s "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN" > /tmp/sys.json
check "摸底阈值默认40" "$(jq -r '.settings[] | select(.key=="practice.diagnostic_batch_size") | .value' /tmp/sys.json)" "40"
curl -s -X PUT "$BASE/admin/settings/practice.diagnostic_batch_size" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"value":25}' >/dev/null
check "阈值可后台调整" "$(curl -s "$BASE/admin/settings" -H "Authorization: Bearer $ADMIN" | jq -r '.settings[] | select(.key=="practice.diagnostic_batch_size") | .value')" "25"

echo "== 修改密码 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/me/password" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"currentPassword":"wrong","newPassword":"newpass123"}')
check "当前密码错误被拒(401)" "$CODE" "401"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/me/password" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d "{\"currentPassword\":\"$STU_PASS\",\"newPassword\":\"abc\"}")
check "弱密码被拒(400)" "$CODE" "400"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/me/password" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d "{\"currentPassword\":\"$STU_PASS\",\"newPassword\":\"newpass123\"}")
check "合规改密成功(200)" "$CODE" "200"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"T001","password":"newpass123"}')
check "新密码可登录" "$CODE" "200"

echo "== 登录限流 =="
for i in 1 2 3 4 5; do
  curl -s -o /dev/null -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d '{"username":"T001","password":"bad"}'
done
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"T001","password":"bad"}')
check "连续5次失败后被限流(429)" "$CODE" "429"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"T001","password":"newpass123"}')
check "锁定期内正确密码也被拒(429)" "$CODE" "429"

echo "== 前端托管与路由回落 =="
ORIGIN="http://localhost:$PORT"
TYPE=$(curl -s -o /tmp/m2-index.html -w '%{content_type}' "$ORIGIN/")
case "$TYPE" in text/html*) check "首页返回 HTML" "ok" "ok" ;; *) check "首页返回 HTML" "$TYPE" "text/html" ;; esac
if grep -q 'id="root"' /tmp/m2-index.html; then
  check "首页是前端应用页面" "ok" "ok"
else
  check "首页是前端应用页面" "no" "ok"
fi
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$ORIGIN/admin/bank")
check "未知前端路由回落到 index.html(200)" "$CODE" "200"
BODY=$(curl -s "$ORIGIN/api/does-not-exist")
case "$BODY" in *not_found*) check "未知接口返回 JSON 404" "ok" "ok" ;; *) check "未知接口返回 JSON 404" "$BODY" "not_found" ;; esac

echo "== 一次性放行脚本 =="
npx wrangler d1 execute eng1300-mvp --local --file=sql/publish-all.sql >/dev/null 2>&1 \
  || { echo "  FAIL publish-all.sql 执行失败"; FAIL=$((FAIL+1)); }
curl -s -o /tmp/stats2.json "$BASE/admin/bank/stats" -H "Authorization: Bearer $ADMIN"
check "存疑记录已清零" "$(jq -r '.unresolvedNotes' /tmp/stats2.json)" "0"
check "两套卷全部已发布" "$(jq -r '[.byCourse[].published_exams] | add' /tmp/stats2.json)" "2"
# 两套卷里所有非存疑题都应已发布。这里按"非存疑"计数，不是按"已发布"计数——
# 后者会拿发布结果去对发布结果，永远相等，测不出漏发。
EXPECT_ALL=$(sql "SELECT COUNT(*) AS n FROM questions WHERE status!='存疑';" | jq -r '.[0].results[0].n')
check "非存疑题全部已发布" "$(jq -r '[.byType[].published] | add' /tmp/stats2.json)" "$EXPECT_ALL"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
