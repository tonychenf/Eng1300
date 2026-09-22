#!/usr/bin/env bash
# M3 冒烟测试：组卷、断点恢复、增量保存、交卷判分、成绩报告、超时自动交卷。
# 用临时的本地 D1 跑，跑完自动清理。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=8792
BASE="http://localhost:$PORT/api"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc";
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

cleanup() {
  # wrangler dev 会派生 workerd 子进程，只杀 wrangler 本身杀不掉它，
  # 它会继续占着端口，下一轮测试就起不来（报 Address already in use，
  # 同时还会一直提示一个已被删掉的构建临时路径，很容易看岔）。
  # 所以用 setsid 让它自成进程组，退出时整组一起杀。
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$ROOT_DIR/.wrangler"
}
trap cleanup EXIT

sql() { npx wrangler d1 execute eng1300-mvp --local --json --command "$1" 2>/dev/null; }

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-m3
SETUP_TOKEN=test-setup-m3
ENCRYPTION_KEY=test-encryption-key-m3
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute eng1300-mvp --local --file="$m" >/dev/null 2>&1
done
npx wrangler d1 execute eng1300-mvp --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
# 三套卷：够凑出每个部分的多个候选篇章，也覆盖被扣下的那道题
# 四套卷：前三套保证每个部分都有至少两篇未被存疑记录点名的完整篇章
# （组卷要挑得出、还要能换篇），最后一套用来验证被扣下的第15题
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "找不到 $EXAM 的种子文件，请先运行 node scripts/build-seed-sql.mjs"; exit 1; }
  npx wrangler d1 execute eng1300-mvp --local --file="$F" >/dev/null 2>&1 \
    || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute eng1300-mvp --local --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 启动服务 =="
DEV_LOG=/tmp/m3-dev.log
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

echo "== 账号准备 =="
curl -s -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-m3' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' >/dev/null
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
mk_student() {
  local name="$1"
  local pw
  pw=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
    -H 'Content-Type: application/json' -d "{\"username\":\"$name\"}" | jq -r '.initialPassword')
  curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
    -d "{\"username\":\"$name\",\"password\":\"$pw\"}" | jq -r '.token'
}
STU=$(mk_student T001)
STU2=$(mk_student T002)
check "两个学员账号登录成功" "$([ -n "$STU" ] && [ -n "$STU2" ] && [ "$STU" != null ] && [ "$STU2" != null ] && echo yes)" "yes"

echo "== 被解析存疑记录点名的题目 =="
HELD_N=$(sql "SELECT COUNT(*) AS n FROM questions WHERE status='存疑';" | jq -r '.[0].results[0].n')
check "有多道题因存疑被扣下" "$(( HELD_N > 1 ))" "1"
echo "     （本次导入的三套卷里共 $HELD_N 道被扣下）"
HELD=$(curl -s "$BASE/admin/bank/exams/13000-2026-04" -H "Authorization: Bearer $ADMIN" \
  | jq -r '[.sections[].questions[] | select(.question_id=="13000-2026-04-q15")][0].status')
check "13000-2026-04 第15题状态为存疑" "$HELD" "存疑"

echo "== 组卷 =="
GEN=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
ATT=$(echo "$GEN" | jq -r '.attemptId')
check "组卷返回 attemptId" "$([ -n "$ATT" ] && [ "$ATT" != null ] && echo yes)" "yes"
check "共 51 题" "$(echo "$GEN" | jq -r '.questionCount')" "51"
check "满分 100" "$(echo "$GEN" | jq -r '.totalScore')" "100"
check "7 个部分" "$(echo "$GEN" | jq -r '.sections | length')" "7"
check "考试时长 150 分钟" "$(echo "$GEN" | jq -r '.timeLimitMinutes')" "150"

echo "== 存疑题不参与组卷 =="
BAD=0; BADSEC=0
for i in 1 2 3 4 5 6; do
  G=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU2" \
    -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
  A=$(echo "$G" | jq -r '.attemptId')
  N=$(sql "SELECT COUNT(*) AS n FROM attempt_questions WHERE attempt_id='$A' AND question_id='13000-2026-04-q15';" | jq -r '.[0].results[0].n')
  S=$(sql "SELECT COUNT(*) AS n FROM attempt_questions WHERE attempt_id='$A' AND section_id='13000-2026-04-s2';" | jq -r '.[0].results[0].n')
  [ "$N" = "0" ] || BAD=$((BAD+1))
  [ "$S" = "0" ] || BADSEC=$((BADSEC+1))
done
check "6 次组卷都没抽到那道存疑题" "$BAD" "0"
# 更强的一条：任何一次组卷都不该出现任何存疑题
ANYHELD=$(sql "SELECT COUNT(*) AS n FROM attempt_questions aq
               JOIN questions q ON q.question_id=aq.question_id
               WHERE q.status='存疑';" | jq -r '.[0].results[0].n')
check "所有已组卷子里都没有存疑题" "$ANYHELD" "0"
check "6 次组卷都没抽到它所在的整篇" "$BADSEC" "0"

echo "== 断点恢复与增量保存 =="
Q1=$(curl -s "$BASE/attempts/$ATT" -H "Authorization: Bearer $STU" | jq -r '.sections[0].questions[0].questionId')
curl -s -o /dev/null -X PUT "$BASE/attempts/$ATT/answers" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d "{\"questionId\":\"$Q1\",\"answer\":\"C\"}"
SAVED=$(curl -s "$BASE/attempts/$ATT" -H "Authorization: Bearer $STU" \
  | jq -r --arg q "$Q1" '[.sections[].questions[] | select(.questionId==$q)][0].userAnswer')
check "作答已保存并可取回" "$SAVED" "C"
REM=$(curl -s "$BASE/attempts/$ATT" -H "Authorization: Bearer $STU" | jq -r '.attempt.remainingSeconds')
check "剩余时间接近 9000 秒" "$([ "$REM" -gt 8900 ] && [ "$REM" -le 9000 ] && echo yes)" "yes"
check "作答阶段不下发正确答案" "$(curl -s "$BASE/attempts/$ATT" -H "Authorization: Bearer $STU" | jq -r '.sections[0].questions[0].correctAnswer')" "null"

echo "== 越权与非法请求 =="
check "别人的作答读不到(403)" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/attempts/$ATT" -H "Authorization: Bearer $STU2")" "403"
check "未登录取作答(401)" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/attempts/$ATT")" "401"
check "存本卷之外的题(404)" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/attempts/$ATT/answers" -H "Authorization: Bearer $STU" \
     -H 'Content-Type: application/json' -d '{"questionId":"不存在的题"}')" "404"
check "不存在的作答(404)" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/attempts/att-nope" -H "Authorization: Bearer $STU")" "404"

echo "== 全对交卷 =="
sql "SELECT aq.question_id AS qid, q.answer AS ans, q.question_type AS qt
       FROM attempt_questions aq JOIN questions q ON q.question_id = aq.question_id
      WHERE aq.attempt_id='$ATT' ORDER BY aq.ord;" | jq -r '.[0].results[] | @base64' > /tmp/m3-keys
while read -r line; do
  ROW=$(echo "$line" | base64 -d)
  QT=$(echo "$ROW" | jq -r '.qt')
  [ "$QT" = "essay" ] && continue
  QID=$(echo "$ROW" | jq -r '.qid')
  ANS=$(echo "$ROW" | jq -r '.ans')
  curl -s -o /dev/null -X PUT "$BASE/attempts/$ATT/answers" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d "$(jq -n --arg q "$QID" --arg a "$ANS" '{questionId:$q,answer:$a}')"
done < /tmp/m3-keys

SUB=$(curl -s -X POST "$BASE/attempts/$ATT/submit" -H "Authorization: Bearer $STU")
check "客观题全对得 70 分" "$(echo "$SUB" | jq -r '.objectiveScore')" "70"
check "作文 1 题待 AI 批改" "$(echo "$SUB" | jq -r '.pendingAi')" "1"
check "七个部分都有小分" "$(echo "$SUB" | jq -r '.sectionScores | length')" "7"
check "重复交卷被拒(409)" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/attempts/$ATT/submit" -H "Authorization: Bearer $STU")" "409"
check "交卷后再改答案被拒(409)" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/attempts/$ATT/answers" -H "Authorization: Bearer $STU" \
     -H 'Content-Type: application/json' -d "{\"questionId\":\"$Q1\",\"answer\":\"A\"}")" "409"

echo "== 成绩报告 =="
REP=$(curl -s "$BASE/attempts/$ATT/report" -H "Authorization: Bearer $STU")
check "报告总分 70" "$(echo "$REP" | jq -r '.attempt.objectiveScore')" "70"
check "报告含 51 题" "$(echo "$REP" | jq -r '[.sections[].questions[]] | length')" "51"
check "报告下发正确答案" "$(echo "$REP" | jq -r '.sections[0].questions[0].correctAnswer | length > 0')" "true"
check "报告含考点得分" "$(echo "$REP" | jq -r '.knowledgePoints | length > 0')" "true"
check "报告含历史次数" "$(echo "$REP" | jq -r '.history.attempts')" "1"
check "掌握度已累计" "$(sql "SELECT COUNT(*) AS n FROM user_knowledge_mastery;" | jq -r '.[0].results[0].n > 0')" "true"

echo "== 判分正确性：故意答错一题 =="
G2=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
A2=$(echo "$G2" | jq -r '.attemptId')
FIRST=$(sql "SELECT aq.question_id AS qid, q.answer AS ans FROM attempt_questions aq
             JOIN questions q ON q.question_id=aq.question_id
             WHERE aq.attempt_id='$A2' AND aq.ord=1;" | jq -r '.[0].results[0]')
FQ=$(echo "$FIRST" | jq -r '.qid'); FA=$(echo "$FIRST" | jq -r '.ans')
WRONG=$([ "$FA" = "A" ] && echo "B" || echo "A")
curl -s -o /dev/null -X PUT "$BASE/attempts/$A2/answers" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d "$(jq -n --arg q "$FQ" --arg a "$WRONG" '{questionId:$q,answer:$a}')"
S2=$(curl -s -X POST "$BASE/attempts/$A2/submit" -H "Authorization: Bearer $STU")
check "只答错一题时得 0 分（其余未答）" "$(echo "$S2" | jq -r '.objectiveScore')" "0"
R2=$(curl -s "$BASE/attempts/$A2/report" -H "Authorization: Bearer $STU")
check "该题标记为答错" "$(echo "$R2" | jq -r --arg q "$FQ" '[.sections[].questions[] | select(.questionId==$q)][0].isCorrect')" "0"

echo "== 篇章不连着重复 =="
S_A=$(sql "SELECT DISTINCT section_id AS s FROM attempt_questions WHERE attempt_id='$ATT' AND section_ord=1;" | jq -r '.[0].results[0].s')
S_B=$(sql "SELECT DISTINCT section_id AS s FROM attempt_questions WHERE attempt_id='$A2' AND section_ord=1;" | jq -r '.[0].results[0].s')
check "第二卷换了阅读判断的篇章" "$([ "$S_A" != "$S_B" ] && echo yes)" "yes"

echo "== 超时自动交卷 =="
G3=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
A3=$(echo "$G3" | jq -r '.attemptId')
sql "UPDATE attempts SET started_at = datetime('now','-151 minutes') WHERE attempt_id='$A3';" >/dev/null
GOT=$(curl -s "$BASE/attempts/$A3" -H "Authorization: Bearer $STU")
check "超时后再进入即已交卷" "$(echo "$GOT" | jq -r '.attempt.status')" "已交卷"
check "标记为自动交卷" "$(echo "$GOT" | jq -r '.attempt.autoSubmitted')" "true"
check "剩余时间归零" "$(echo "$GOT" | jq -r '.attempt.remainingSeconds')" "0"

echo "== 历史记录 =="
check "历史里有 3 次模考" "$(curl -s "$BASE/history" -H "Authorization: Bearer $STU" | jq -r '.attempts | length')" "3"
check "不串号：另一个学员看不到" \
  "$(curl -s "$BASE/history" -H "Authorization: Bearer $STU2" | jq -r '[.attempts[] | select(.attempt_id=="'"$ATT"'")] | length')" "0"

echo "== 题库不足时的报错 =="
check "不存在的课程(404)" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
     -H 'Content-Type: application/json' -d '{"courseCode":"99999"}')" "404"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
