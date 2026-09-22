#!/usr/bin/env bash
# M6 整体联调验收：从零开始走完一个学员的完整旅程，再验后台看板与数据导出。
#
# 与 M2–M5 的分模块冒烟不同，这里只关心"串起来能不能用"：
# 建账号 -> 组卷 -> 作答 -> 交卷 -> AI 批改 -> 错题本 -> 专项练习 -> 订正
# -> 能力评估 -> 后台看到这个学员的学情 -> 导出的数据里能找到他这次作答。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=8796
STUB_PORT=8898
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
stu() { curl -s -H "Authorization: Bearer $STU" "$@"; }
adm() { curl -s -H "Authorization: Bearer $ADMIN" "$@"; }

echo "== 从空库开始 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-m6
SETUP_TOKEN=test-setup-m6
ENCRYPTION_KEY=test-encryption-key-m6
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute eng1300-mvp --local --file="$m" >/dev/null 2>&1
done
npx wrangler d1 execute eng1300-mvp --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  npx wrangler d1 execute eng1300-mvp --local --file="$(ls seed/*"$EXAM".sql | head -1)" >/dev/null 2>&1
done
npx wrangler d1 execute eng1300-mvp --local --file=sql/publish-all.sql >/dev/null 2>&1

node test/ai-stub.mjs "$STUB_PORT" > /tmp/m6-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/m6-dev.log
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

echo "== 1. 管理员开账号 =="
curl -s -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-m6' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' >/dev/null
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
check "超管登录" "$([ -n "$ADMIN" ] && [ "$ADMIN" != null ] && echo yes)" "yes"
adm -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "http://127.0.0.1:$STUB_PORT/v1" '{baseUrl:$u,apiKey:"k",model:"m",protocol:"openai"}')"
PW=$(adm -X POST "$BASE/admin/users" -H 'Content-Type: application/json' \
  -d '{"username":"T001"}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"T001\",\"password\":\"$PW\"}" | jq -r '.token')
check "学员用初始密码登录" "$([ -n "$STU" ] && [ "$STU" != null ] && echo yes)" "yes"

echo "== 2. 学员看到可用题库 =="
C=$(stu "$BASE/courses")
check "课程只剩合并后的一门" "$(echo "$C" | jq -r '.courses | length')" "1"
check "课程有可用题目" "$(echo "$C" | jq -r '.courses[0].published_questions > 0')" "true"

echo "== 3. 组卷并作答 =="
take_exam() {
  local wrong_stride="$1"
  local gen aid
  gen=$(stu -X POST "$BASE/exams/generate" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
  aid=$(echo "$gen" | jq -r '.attemptId')
  sql "SELECT aq.question_id AS qid, q.answer AS ans, q.question_type AS qt
         FROM attempt_questions aq JOIN questions q ON q.question_id=aq.question_id
        WHERE aq.attempt_id='$aid' ORDER BY aq.ord;" | jq -r '.[0].results[] | @base64' > /tmp/m6-keys
  local i=0
  while read -r line; do
    local row qt qid ans a
    row=$(echo "$line" | base64 -d)
    qt=$(echo "$row" | jq -r '.qt'); qid=$(echo "$row" | jq -r '.qid'); ans=$(echo "$row" | jq -r '.ans')
    if [ "$qt" = "essay" ]; then
      a="Online shopping is now part of daily life. It saves time but quality varies."
    else
      i=$((i+1))
      if [ $((i % wrong_stride)) -eq 0 ]; then a="ZZZ"; else a="$ans"; fi
    fi
    stu -o /dev/null -X PUT "$BASE/attempts/$aid/answers" -H 'Content-Type: application/json' \
      -d "$(jq -n --arg q "$qid" --arg v "$a" '{questionId:$q,answer:$v}')"
  done < /tmp/m6-keys
  stu -o /dev/null -X POST "$BASE/attempts/$aid/submit"
  echo "$aid"
}
A1=$(take_exam 4)
R1=$(stu "$BASE/attempts/$A1/report")
check "交卷即出客观题成绩" "$(echo "$R1" | jq -r '.attempt.objectiveScore > 0')" "true"
check "七个部分都有小分" "$(echo "$R1" | jq -r '.sectionScores | length')" "7"
check "组卷没有混进存疑题" \
  "$(sql "SELECT COUNT(*) AS n FROM attempt_questions aq JOIN questions q ON q.question_id=aq.question_id
          WHERE aq.attempt_id='$A1' AND q.status='存疑';" | jq -r '.[0].results[0].n')" "0"

echo "== 4. AI 批改与错题解析 =="
AIR=$(stu -X POST "$BASE/ai/attempts/$A1/run")
check "作文批改完成" "$(echo "$AIR" | jq -r '.essay.status')" "graded"
check "错题解析已生成" "$(echo "$AIR" | jq -r '.wrongItems.done > 0')" "true"
check "报告的待批改归零" "$(stu "$BASE/attempts/$A1/report" | jq -r '.attempt.pendingAi')" "0"

echo "== 5. 错题本 =="
WB=$(stu "$BASE/wrongbook?courseCode=13000")
check "错题进了错题本" "$(echo "$WB" | jq -r '.total > 0')" "true"
check "错题带错因与记忆要点" \
  "$(echo "$WB" | jq -r '[.items[] | select(.errorAnalysis != null and .memoryPoint != null)] | length > 0')" "true"
WRONG_BEFORE=$(echo "$WB" | jq -r '.total')

echo "== 6. 专项练习并订正一道错题 =="
# 挑"所属考点题目最少"的那道错题：专项练习按历史做过次数升序出题，做过的
# 排在最后，如果考点下有几十道题，有限的轮次根本轮不到它——那测出来的是
# 题库深度，不是订正规则。
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
  D=$(stu -X POST "$BASE/practice/drill" -H 'Content-Type: application/json' \
    -d "$(jq -n --arg c 13000 --arg t "$TAG" '{courseCode:$c,tagId:$t}')")
  DID=$(echo "$D" | jq -r '.attemptId')
  for i in $(seq 1 60); do
    N=$(stu "$BASE/practice/$DID/next")
    [ "$(echo "$N" | jq -r '.done // false')" = "true" ] && break
    QID=$(echo "$N" | jq -r '.question.questionId')
    ANS=$(sql "SELECT answer AS a FROM questions WHERE question_id='$QID';" | jq -r '.[0].results[0].a')
    stu -o /dev/null -X POST "$BASE/practice/$DID/answer" -H 'Content-Type: application/json' \
      -d "$(jq -n --arg q "$QID" --arg a "$ANS" '{questionId:$q,answer:$a}')"
    [ "$QID" = "$QW" ] && { HIT=$((HIT+1)); break; }
  done
  stu -o /dev/null -X POST "$BASE/practice/$DID/end"
done
check "专项练习里做到了那道错题" "$HIT" "2"
check "连对两次后自动订正" \
  "$(sql "SELECT corrected AS c FROM wrong_items WHERE question_id='$QW';" | jq -r '.[0].results[0].c')" "1"
check "待订正数量相应减少" \
  "$(( $(stu "$BASE/wrongbook?courseCode=13000" | jq -r '.total') < WRONG_BEFORE ))" "1"

echo "== 7. 再考一次后出能力评估 =="
A2=$(take_exam 6)
stu -o /dev/null -X POST "$BASE/ai/attempts/$A2/run"
AS=$(stu "$BASE/assessment?courseCode=13000")
check "两次模考后给出预测" "$(echo "$AS" | jq -r '.enoughData')" "true"
check "预测分在 0-100 之间" \
  "$(awk -v p="$(echo "$AS" | jq -r '.statistical.predicted')" 'BEGIN{print (p>=0 && p<=100)?1:0}')" "1"
check "趋势里有两次成绩" "$(echo "$AS" | jq -r '.trend | length')" "2"
AIA=$(stu -X POST "$BASE/ai/assessment" -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
check "AI 综合意见可用" "$(echo "$AIA" | jq -r '.ai.levelDesc | length > 0')" "true"

echo "== 8. 后台看板看得到这个学员 =="
OV=$(adm "$BASE/admin/stats/overview")
check "概览里有 1 个学员" "$(echo "$OV" | jq -r '.overview.students')" "1"
check "概览里模考数为 2" "$(echo "$OV" | jq -r '.overview.exams_done')" "2"
check "概览区分了可抽题与存疑题" "$(echo "$OV" | jq -r '.overview.questions_held > 0')" "true"
ST=$(adm "$BASE/admin/stats/students")
check "学情列表有该学员" "$(echo "$ST" | jq -r '.students[0].username')" "T001"
check "学情记录了模考次数" "$(echo "$ST" | jq -r '.students[0].exam_count')" "2"
check "学情记录了已订正错题" "$(echo "$ST" | jq -r '.students[0].wrong_cleared > 0')" "true"
UID2=$(echo "$ST" | jq -r '.students[0].id')
DT=$(adm "$BASE/admin/stats/students/$UID2")
check "学员详情含掌握度分档" "$(echo "$DT" | jq -r '.tierCount | length > 0')" "true"
check "学员详情含作答记录" "$(echo "$DT" | jq -r '.attempts | length > 0')" "true"
check "普通用户看不到学情(403)" \
  "$(stu -o /dev/null -w '%{http_code}' "$BASE/admin/stats/students")" "403"

echo "== 9. 数据导出 =="
adm -o /tmp/m6-bank.json "$BASE/admin/stats/export/bank?courseCode=13000"
check "题库导出是合法 JSON" "$(jq -e 'type=="object"' /tmp/m6-bank.json >/dev/null && echo yes)" "yes"
check "导出含 4 套试卷" "$(jq -r '.examCount' /tmp/m6-bank.json)" "4"
check "导出的题目带考点标签" \
  "$(jq -r '[.exams[].sections[].questions[] | select(.knowledgePoints | length > 0)] | length > 0' /tmp/m6-bank.json)" "true"
check "导出保留了存疑状态" \
  "$(jq -r '[.exams[].sections[].questions[] | select(.status=="存疑")] | length > 0' /tmp/m6-bank.json)" "true"
adm -o /tmp/m6-rec.json "$BASE/admin/stats/export/records?userId=$UID2"
check "记录导出是合法 JSON" "$(jq -e 'type=="object"' /tmp/m6-rec.json >/dev/null && echo yes)" "yes"
check "导出含这两次模考" \
  "$(jq -r '[.attempts[] | select(.mode=="EXAM")] | length' /tmp/m6-rec.json)" "2"
check "导出含逐题作答" "$(jq -r '.counts.answers > 0' /tmp/m6-rec.json)" "true"
check "导出含错题本" "$(jq -r '.counts.wrongItems > 0' /tmp/m6-rec.json)" "true"
check "导出含掌握度" "$(jq -r '.counts.mastery > 0' /tmp/m6-rec.json)" "true"
check "导出的部分小分已还原成对象" \
  "$(jq -r '[.attempts[] | select(.section_scores != null)][0].section_scores | type' /tmp/m6-rec.json)" "array"
check "普通用户不能导出(403)" \
  "$(stu -o /dev/null -w '%{http_code}' "$BASE/admin/stats/export/bank")" "403"
CT=$(adm -o /dev/null -w '%{content_type}' "$BASE/admin/stats/export/bank?courseCode=13000")
check "导出带 JSON 内容类型" "$(echo "$CT" | grep -c json)" "1"

echo "== 10. 前端页面都能打开 =="
BAD_PAGES=0
for p in /login /admin/login /app /app/exam/new /app/practice/new /app/wrongbook /app/assessment /app/history /admin /admin/students /admin/export; do
  CODE=$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$PORT$p")
  [ "$CODE" = "200" ] || { echo "     $p 返回 $CODE"; BAD_PAGES=$((BAD_PAGES+1)); }
done
check "11 个前端路由都回落到应用页面" "$BAD_PAGES" "0"
check "未知接口仍返回 JSON 404" \
  "$(curl -s "http://localhost:$PORT/api/nope" | jq -r '.error')" "not_found"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
