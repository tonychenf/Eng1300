#!/usr/bin/env bash
# M5 冒烟测试：AI 作文批改、错题分析、错题本、能力评估，以及 AI 不可用时的降级。
# AI 走本地替身（test/ai-stub.mjs），沙箱连不上真实服务商。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=8794
STUB_PORT=8899
BASE="http://localhost:$PORT/api"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc";
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill -- "-$SERVER_PID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$ROOT_DIR/.wrangler"
}
trap cleanup EXIT

sql() { npx wrangler d1 execute eng1300-mvp --local --json --command "$1" 2>/dev/null; }
au() { curl -s -H "Authorization: Bearer $STU" "$@"; }

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-m5
SETUP_TOKEN=test-setup-m5
ENCRYPTION_KEY=test-encryption-key-m5
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute eng1300-mvp --local --file="$m" >/dev/null 2>&1
done
npx wrangler d1 execute eng1300-mvp --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  npx wrangler d1 execute eng1300-mvp --local --file="$(ls seed/*"$EXAM".sql | head -1)" >/dev/null 2>&1
done
npx wrangler d1 execute eng1300-mvp --local --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 启动 AI 替身与服务 =="
node test/ai-stub.mjs "$STUB_PORT" > /tmp/m5-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/m5-dev.log
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
ready=0
for i in $(seq 1 150); do
  if curl -s -m 2 -o /dev/null "$BASE/health"; then ready=1; break; fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo "服务在 150 秒内没有就绪。dev 日志尾部："; tail -20 "$DEV_LOG"; exit 1
fi

curl -s -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-m5' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' >/dev/null
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
PW=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"T001"}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"T001\",\"password\":\"$PW\"}" | jq -r '.token')

set_ai() {
  curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN" \
    -H 'Content-Type: application/json' \
    -d "$(jq -n --arg u "$1" '{baseUrl:$u,apiKey:"stub-key",model:"stub-model",protocol:"openai"}')"
}
set_ai "http://127.0.0.1:$STUB_PORT/v1"

# 交一份卷：前若干题故意答错，作文写点东西
run_exam() {
  local wrong_n="$1" essay="$2"
  local gen aid
  gen=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
  aid=$(echo "$gen" | jq -r '.attemptId')
  sql "SELECT aq.ord AS o, aq.question_id AS qid, q.answer AS ans, q.question_type AS qt
         FROM attempt_questions aq JOIN questions q ON q.question_id=aq.question_id
        WHERE aq.attempt_id='$aid' ORDER BY aq.ord;" | jq -r '.[0].results[] | @base64' > /tmp/m5-keys
  local i=0
  while read -r line; do
    local row qt qid ans a
    row=$(echo "$line" | base64 -d)
    qt=$(echo "$row" | jq -r '.qt'); qid=$(echo "$row" | jq -r '.qid'); ans=$(echo "$row" | jq -r '.ans')
    if [ "$qt" = "essay" ]; then a="$essay"; else
      i=$((i+1))
      if [ "$i" -le "$wrong_n" ]; then a="ZZZ"; else a="$ans"; fi
    fi
    curl -s -o /dev/null -X PUT "$BASE/attempts/$aid/answers" -H "Authorization: Bearer $STU" \
      -H 'Content-Type: application/json' -d "$(jq -n --arg q "$qid" --arg v "$a" '{questionId:$q,answer:$v}')"
  done < /tmp/m5-keys
  curl -s -o /dev/null -X POST "$BASE/attempts/$aid/submit" -H "Authorization: Bearer $STU"
  echo "$aid"
}

echo "== 交卷即建错题，不等 AI =="
A1=$(run_exam 6 "Online shopping is very popular now. I think it is convenient and cheap.")
WB=$(sql "SELECT COUNT(*) AS n FROM wrong_items;" | jq -r '.[0].results[0].n')
check "错题已在交卷时落库" "$(( WB >= 6 ))" "1"
check "此时还没有 AI 分析" \
  "$(sql "SELECT COUNT(*) AS n FROM wrong_items WHERE ai_status='已生成';" | jq -r '.[0].results[0].n')" "0"
R1=$(au "$BASE/attempts/$A1/report")
check "客观题成绩不依赖 AI 就已产生" "$(echo "$R1" | jq -r '.attempt.objectiveScore > 0')" "true"
check "作文标为待批改" "$(echo "$R1" | jq -r '.attempt.pendingAi')" "1"

echo "== AI 批改与错题分析 =="
AIR=$(curl -s -X POST "$BASE/ai/attempts/$A1/run" -H "Authorization: Bearer $STU")
check "作文批改成功" "$(echo "$AIR" | jq -r '.essay.status')" "graded"
ESSAY=$(echo "$AIR" | jq -r '.essay.total')
check "作文分在 0-30 之间" "$(awk -v s="$ESSAY" 'BEGIN{print (s>0 && s<=30) ? 1 : 0}')" "1"
check "错题分析已生成" "$(echo "$AIR" | jq -r '.wrongItems.done > 0')" "true"
check "没有失败的错题分析" "$(echo "$AIR" | jq -r '.wrongItems.failed')" "0"
R1B=$(au "$BASE/attempts/$A1/report")
check "批改后待批改数归零" "$(echo "$R1B" | jq -r '.attempt.pendingAi')" "0"
OBJ=$(echo "$R1B" | jq -r '.attempt.objectiveScore'); TOT=$(echo "$R1B" | jq -r '.attempt.totalScore')
check "总分 = 客观题 + 作文" "$(awk -v t="$TOT" -v o="$OBJ" -v e="$ESSAY" 'BEGIN{print (t>o && (t-o-e)<0.05 && (t-o-e)>-0.05) ? 1 : 0}')" "1"

echo "== 错题本 =="
W=$(au "$BASE/wrongbook?courseCode=13000")
check "错题本有条目" "$(echo "$W" | jq -r '.items | length > 0')" "true"
check "错题带 AI 错因" "$(echo "$W" | jq -r '.items[0].errorAnalysis | length > 0')" "true"
check "错题带记忆要点" "$(echo "$W" | jq -r '.items[0].memoryPoint | length > 0')" "true"
check "错题带考点标签" "$(echo "$W" | jq -r '.items[0].knowledgePoints | length > 0')" "true"
check "错题记录来源" "$(echo "$W" | jq -r '.items[0].source')" "模考"
F=$(au "$BASE/wrongbook/filters")
check "筛选项给出题型" "$(echo "$F" | jq -r '.sectionTypes | length > 0')" "true"
FIRST_TYPE=$(echo "$F" | jq -r '.sectionTypes[0].section_type')
FN=$(echo "$F" | jq -r '.sectionTypes[0].n')
check "按题型筛选生效" "$(au "$BASE/wrongbook?courseCode=13000&sectionType=$FIRST_TYPE" | jq -r '.total')" "$FN"

echo "== 连续答对两次自动订正 =="
# 挑"所属考点题目最少"的那道错题：专项练习按历史做过次数升序出题，做过的
# 排在最后，考点下题一多就轮不到它——那测出来的是题库深度，不是订正规则。
PICK=$(sql "SELECT w.question_id AS q, x.tag_id AS t,
              (SELECT COUNT(*) FROM questions q2
                 JOIN question_knowledge_points x2 ON x2.question_id = q2.question_id
                WHERE x2.tag_id = x.tag_id AND q2.status = '已发布' AND q2.course_code = '13000') AS n
            FROM wrong_items w
            JOIN question_knowledge_points x ON x.question_id = w.question_id
            WHERE w.corrected = 0
            ORDER BY n ASC LIMIT 1;" | jq -r '.[0].results[0]')
QW=$(echo "$PICK" | jq -r '.q'); TAG=$(echo "$PICK" | jq -r '.t')
echo "     （选中的错题所属考点共 $(echo "$PICK" | jq -r '.n') 道题）"
HIT=0
for round in 1 2; do
  D=$(curl -s -X POST "$BASE/practice/drill" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d "$(jq -n --arg c 13000 --arg t "$TAG" '{courseCode:$c,tagId:$t}')")
  DID=$(echo "$D" | jq -r '.attemptId')
  for i in $(seq 1 60); do
    N=$(au "$BASE/practice/$DID/next")
    [ "$(echo "$N" | jq -r '.done // false')" = "true" ] && break
    QID=$(echo "$N" | jq -r '.question.questionId')
    ANS=$(sql "SELECT answer AS a FROM questions WHERE question_id='$QID';" | jq -r '.[0].results[0].a')
    curl -s -o /dev/null -X POST "$BASE/practice/$DID/answer" -H "Authorization: Bearer $STU" \
      -H 'Content-Type: application/json' -d "$(jq -n --arg q "$QID" --arg a "$ANS" '{questionId:$q,answer:$a}')"
    [ "$QID" = "$QW" ] && { HIT=$((HIT+1)); break; }
  done
  curl -s -o /dev/null -X POST "$BASE/practice/$DID/end" -H "Authorization: Bearer $STU"
done
check "那道错题在两轮专项里都被答对" "$HIT" "2"
check "连对两次后自动标记已订正" \
  "$(sql "SELECT corrected AS c FROM wrong_items WHERE question_id='$QW';" | jq -r '.[0].results[0].c')" "1"
check "默认不列已订正的题" \
  "$(au "$BASE/wrongbook?courseCode=13000" | jq -r --arg q "$QW" '[.items[] | select(.questionId==$q)] | length')" "0"
check "带上参数能看到已订正的题" \
  "$(au "$BASE/wrongbook?courseCode=13000&includeCorrected=1" | jq -r --arg q "$QW" '[.items[] | select(.questionId==$q)] | length')" "1"

echo "== 能力评估 =="
AS1=$(au "$BASE/assessment?courseCode=13000")
check "只有 1 次模考时不给预测" "$(echo "$AS1" | jq -r '.enoughData')" "false"
check "并说明还差几次" "$(echo "$AS1" | jq -r '.message')" "再完成 1 次模考即可生成预测"
A2=$(run_exam 2 "Shopping online saves time. But quality can be a problem sometimes.")
curl -s -o /dev/null -X POST "$BASE/ai/attempts/$A2/run" -H "Authorization: Bearer $STU"
AS2=$(au "$BASE/assessment?courseCode=13000")
check "两次模考后给出预测" "$(echo "$AS2" | jq -r '.enoughData')" "true"
P=$(echo "$AS2" | jq -r '.statistical.predicted')
check "预测分在 0-100 之间" "$(awk -v p="$P" 'BEGIN{print (p>=0 && p<=100) ? 1 : 0}')" "1"
check "预测区间下界不高于预测值" \
  "$(awk -v l="$(echo "$AS2" | jq -r '.statistical.low')" -v p="$P" 'BEGIN{print (l<=p) ? 1 : 0}')" "1"
check "按部分给出预测" "$(echo "$AS2" | jq -r '.statistical.sections | length')" "7"
check "含考点掌握分布" "$(echo "$AS2" | jq -r '.tierCount | length > 0')" "true"
check "含历史趋势" "$(echo "$AS2" | jq -r '.trend | length')" "2"
AIA=$(curl -s -X POST "$BASE/ai/assessment" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
check "AI 定性评估返回水平定位" "$(echo "$AIA" | jq -r '.ai.levelDesc | length > 0')" "true"
check "AI 给出优先补强考点" "$(echo "$AIA" | jq -r '.ai.weakPoints | length > 0')" "true"
check "AI 建议不超过 3 条" "$(echo "$AIA" | jq -r '.ai.suggestions | length <= 3')" "true"

echo "== AI 不可用时的降级 =="
set_ai "http://127.0.0.1:$STUB_PORT/fail/v1"
A3=$(run_exam 3 "A short essay for the failure path.")
R3=$(au "$BASE/attempts/$A3/report")
check "AI 挂了客观题成绩照常出" "$(echo "$R3" | jq -r '.attempt.objectiveScore >= 0')" "true"
AIR3=$(curl -s -X POST "$BASE/ai/attempts/$A3/run" -H "Authorization: Bearer $STU")
check "作文批改标为失败" "$(echo "$AIR3" | jq -r '.essay.status')" "failed"
check "错题分析记为失败" "$(echo "$AIR3" | jq -r '.wrongItems.failed > 0')" "true"
check "失败的错题标为待重试" \
  "$(sql "SELECT COUNT(*) AS n FROM wrong_items WHERE ai_status='待重试';" | jq -r '.[0].results[0].n > 0')" "true"
check "错题本仍可打开" "$(au "$BASE/wrongbook?courseCode=13000" | jq -r '.items | length > 0')" "true"
check "统计预测不受 AI 影响" "$(au "$BASE/assessment?courseCode=13000" | jq -r '.enoughData')" "true"
check "AI 评估失败返回 503" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ai/assessment" -H "Authorization: Bearer $STU" \
     -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')" "503"

echo "== AI 返回非法 JSON 时重试后放弃 =="
set_ai "http://127.0.0.1:$STUB_PORT/bad/v1"
A4=$(run_exam 2 "Another essay.")
AIR4=$(curl -s -X POST "$BASE/ai/attempts/$A4/run" -H "Authorization: Bearer $STU")
check "非法 JSON 最终判为失败" "$(echo "$AIR4" | jq -r '.essay.status')" "failed"
check "失败原因是 JSON 解析" "$(echo "$AIR4" | jq -r '.essay.error')" "ai_bad_json"

echo "== 用量都有记账 =="
check "AI 调用已记入用量日志" \
  "$(sql "SELECT COUNT(*) AS n FROM ai_usage_logs;" | jq -r '.[0].results[0].n > 0')" "true"
check "失败调用也记了" \
  "$(sql "SELECT COUNT(*) AS n FROM ai_usage_logs WHERE success=0;" | jq -r '.[0].results[0].n > 0')" "true"

echo "== 越权 =="
PW2=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"T002"}' | jq -r '.initialPassword')
STU2=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"T002\",\"password\":\"$PW2\"}" | jq -r '.token')
check "别人的作答不能跑 AI(403)" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/ai/attempts/$A1/run" -H "Authorization: Bearer $STU2")" "403"
check "错题本只看得到自己的" \
  "$(curl -s "$BASE/wrongbook?courseCode=13000" -H "Authorization: Bearer $STU2" | jq -r '.items | length')" "0"
check "未登录读错题本(401)" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/wrongbook")" "401"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
