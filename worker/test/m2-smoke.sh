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

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  pkill -f "wrangler dev.*$PORT" 2>/dev/null
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
for m in migrations/0001_init.sql migrations/0002_bank.sql migrations/0003_security.sql; do
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
npx wrangler dev --local --port $PORT > /tmp/m2-dev.log 2>&1 &
SERVER_PID=$!
for i in $(seq 1 40); do
  curl -s -o /dev/null "$BASE/health" && break
  sleep 0.5
done

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
check "统计含两门课程" "$(jq '.byCourse | length' /tmp/stats.json)" "2"

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

# 把一题标为存疑，验证它不会被发布
curl -s -X PATCH "$BASE/admin/bank/questions/00015-2024-04-q1" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"status":"存疑"}' >/dev/null

CODE=$(curl -s -o /tmp/pub.json -w '%{http_code}' -X POST \
  "$BASE/admin/bank/exams/00015-2024-04/publish" -H "Authorization: Bearer $ADMIN")
check "处理完存疑后可发布(200)" "$CODE" "200"
check "发布50题" "$(jq -r '.published' /tmp/pub.json)" "50"
check "存疑题保留未发布" "$(jq -r '.held' /tmp/pub.json)" "1"

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
check "普通用户可读课程列表" "$(jq '.courses | length' /tmp/courses.json)" "2"
check "00015已发布题数为50" "$(jq -r '.courses[] | select(.course_code=="00015") | .published_questions' /tmp/courses.json)" "50"

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

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
