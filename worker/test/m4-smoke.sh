#!/usr/bin/env bash
# M4 冒烟测试：专项练习的两阶段自适应出题、即时反馈、掌握度推进、总结与单考点专项。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT=8793
BASE="http://localhost:$PORT/api"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc";
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$ROOT_DIR/.wrangler"
}
trap cleanup EXIT

sql() { npx wrangler d1 execute eng1300-mvp --local --json --command "$1" 2>/dev/null; }

# 循环里要反复查"这题的答案是什么""这题带不带某个考点"。每次都起一个 wrangler
# 进程的话一轮测试要十几分钟，所以开跑前一次性导出到本地文件，之后用 jq 查。
dump_lookups() {
  sql "SELECT question_id AS q, answer AS a FROM questions;" \
    | jq -r '.[0].results | map({key: .q, value: .a}) | from_entries' > /tmp/m4-answers.json
  sql "SELECT question_id AS q, tag_id AS t FROM question_knowledge_points;" \
    | jq -r '.[0].results | group_by(.q) | map({key: .[0].q, value: map(.t)}) | from_entries' > /tmp/m4-qtags.json
}
answer_of() { jq -r --arg q "$1" '.[$q] // ""' /tmp/m4-answers.json; }
has_tag() { jq -r --arg q "$1" --arg t "$2" '(.[$q] // []) | index($t) != null' /tmp/m4-qtags.json; }

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-m4
SETUP_TOKEN=test-setup-m4
ENCRYPTION_KEY=test-encryption-key-m4
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute eng1300-mvp --local --file="$m" >/dev/null 2>&1
done
npx wrangler d1 execute eng1300-mvp --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2024-04 13000-2024-10 13000-2026-04; do
  npx wrangler d1 execute eng1300-mvp --local --file="$(ls seed/*"$EXAM".sql | head -1)" >/dev/null 2>&1
done
npx wrangler d1 execute eng1300-mvp --local --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 启动服务 =="
DEV_LOG=/tmp/m4-dev.log
npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PID=$!
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

curl -s -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-m4' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' >/dev/null
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
PW=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"T001"}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"T001\",\"password\":\"$PW\"}" | jq -r '.token')
PW2=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"T002"}' | jq -r '.initialPassword')
STU2=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"T002\",\"password\":\"$PW2\"}" | jq -r '.token')

au() { curl -s -H "Authorization: Bearer $STU" "$@"; }

dump_lookups

echo "== 范围预览 =="
SCOPE=$(au "$BASE/practice/scope?courseCode=13000")
check "范围内考点数大于 0" "$(echo "$SCOPE" | jq -r '.knowledgePoints | length > 0')" "true"
check "范围内题目数大于 0" "$(echo "$SCOPE" | jq -r '.questionCount > 0')" "true"
TYPES=$(au "$BASE/practice/section-types?courseCode=13000")
check "题型列表含 7 类" "$(echo "$TYPES" | jq -r '.sectionTypes | length')" "7"
NARROW=$(au "$BASE/practice/scope?courseCode=13000&sectionTypes=%E9%98%85%E8%AF%BB%E5%88%A4%E6%96%AD")
check "限定题型后题目数变少" \
  "$(( $(echo "$NARROW" | jq -r '.questionCount') < $(echo "$SCOPE" | jq -r '.questionCount') ))" "1"

echo "== 开始练习 =="
ST=$(curl -s -X POST "$BASE/practice/start" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"13000"}')
P=$(echo "$ST" | jq -r '.attemptId')
check "创建练习会话" "$([ -n "$P" ] && [ "$P" != null ] && echo yes)" "yes"
check "初始阶段为摸底" "$(echo "$ST" | jq -r '.stage')" "摸底"
check "空范围课程被拒(404)" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/practice/start" -H "Authorization: Bearer $STU" \
     -H 'Content-Type: application/json' -d '{"courseCode":"99999"}')" "404"

echo "== 摸底阶段：每个考点先出一道 =="
# 连续取 12 题，全部答对，记录每题的考点
: > /tmp/m4-tags
STAGES=""
for i in $(seq 1 12); do
  N=$(au "$BASE/practice/$P/next")
  QID=$(echo "$N" | jq -r '.question.questionId')
  STAGES="$STAGES $(echo "$N" | jq -r '.stage')"
  ANS=$(answer_of "$QID")
  R=$(curl -s -X POST "$BASE/practice/$P/answer" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d "$(jq -n --arg q "$QID" --arg a "$ANS" '{questionId:$q,answer:$a}')")
  echo "$R" | jq -r '.knowledgePoints[]?' >> /tmp/m4-tags
  [ "$i" = "1" ] && FIRST="$R"
done
check "前 12 题都在摸底阶段" "$(echo "$STAGES" | tr ' ' '\n' | grep -c 摸底)" "12"
check "摸底阶段考点不重复" \
  "$(( $(sort -u /tmp/m4-tags | wc -l) == $(sort /tmp/m4-tags | wc -l) ))" "1"
check "答对即时反馈" "$(echo "$FIRST" | jq -r '.isCorrect')" "1"
check "反馈里带正确答案" "$(echo "$FIRST" | jq -r '.correctAnswer | length > 0')" "true"
check "反馈里带考点标签" "$(echo "$FIRST" | jq -r '.knowledgePoints | length > 0')" "true"
check "同一题重复作答被拒(409)" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/practice/$P/answer" -H "Authorization: Bearer $STU" \
     -H 'Content-Type: application/json' -d "$(jq -n --arg q "$(sql "SELECT question_id AS q FROM attempt_questions WHERE attempt_id='$P' AND ord=1;" | jq -r '.[0].results[0].q')" '{questionId:$q,answer:"A"}')")" "409"

echo "== 掌握度推进 =="
M=$(sql "SELECT COUNT(*) AS n FROM user_knowledge_mastery WHERE user_id=(SELECT id FROM users WHERE username='T001');" | jq -r '.[0].results[0].n')
check "掌握度已记录多个考点" "$(( M >= 10 ))" "1"
STREAK=$(sql "SELECT MIN(consecutive_correct) AS s FROM user_knowledge_mastery WHERE user_id=(SELECT id FROM users WHERE username='T001');" | jq -r '.[0].results[0].s')
check "全答对后连对次数不为 0" "$(( STREAK >= 1 ))" "1"

echo "== 摸底做完后转入强化 =="
# 把剩下的考点问完，直到阶段变成强化
STAGE=""
for i in $(seq 1 30); do
  N=$(au "$BASE/practice/$P/next")
  [ "$(echo "$N" | jq -r '.done // false')" = "true" ] && break
  STAGE=$(echo "$N" | jq -r '.stage')
  QID=$(echo "$N" | jq -r '.question.questionId')
  ANS=$(answer_of "$QID")
  curl -s -o /dev/null -X POST "$BASE/practice/$P/answer" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d "$(jq -n --arg q "$QID" --arg a "$ANS" '{questionId:$q,answer:$a}')"
  [ "$STAGE" = "强化" ] && break
done
check "考点问完一轮后进入强化阶段" "$STAGE" "强化"
check "会话阶段已落库" "$(sql "SELECT practice_stage AS s FROM attempts WHERE attempt_id='$P';" | jq -r '.[0].results[0].s')" "强化"

echo "== 答错的考点会被优先重出 =="
# 直接把对比拉开：其余考点全设成"连对三次"（权重 0.3），单独一个设成"最近答错"
# （权重 5.0）。按 PRD §7.2 这时薄弱考点的中签率应该是 5/(5+20*0.3)≈45%，
# 20 次抽题期望命中 9 次，远高于均分，不用靠运气就能判出来。
USER_ID=$(sql "SELECT id AS i FROM users WHERE username='T001';" | jq -r '.[0].results[0].i')
sql "UPDATE user_knowledge_mastery SET last_result='correct', consecutive_correct=3, correct_count=3
     WHERE user_id=$USER_ID;" >/dev/null
WEAK=$(sql "SELECT tag_id AS t FROM user_knowledge_mastery WHERE user_id=$USER_ID ORDER BY tag_id LIMIT 1;" | jq -r '.[0].results[0].t')
sql "UPDATE user_knowledge_mastery SET last_result='wrong', consecutive_correct=0
     WHERE user_id=$USER_ID AND tag_id='$WEAK';" >/dev/null

HITS=0; DRAWS=0
for i in $(seq 1 20); do
  N=$(au "$BASE/practice/$P/next")
  [ "$(echo "$N" | jq -r '.done // false')" = "true" ] && break
  DRAWS=$((DRAWS+1))
  QID=$(echo "$N" | jq -r '.question.questionId')
  [ "$(has_tag "$QID" "$WEAK")" = "true" ] && HITS=$((HITS+1))
  curl -s -o /dev/null -X POST "$BASE/practice/$P/answer" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d "$(jq -n --arg q "$QID" '{questionId:$q,answer:"故意答错"}')"
  # 维持它的"最近答错"状态，其余考点保持连对三次。两条并成一次调用，少起一个进程。
  sql "UPDATE user_knowledge_mastery SET last_result='correct', consecutive_correct=3 WHERE user_id=$USER_ID;
       UPDATE user_knowledge_mastery SET last_result='wrong', consecutive_correct=0 WHERE user_id=$USER_ID AND tag_id='$WEAK';" >/dev/null
done
echo "     （$DRAWS 次抽题里薄弱考点命中 $HITS 次，理论期望约 45%）"
check "薄弱考点的中签率远高于均分" "$(( HITS >= 5 ))" "1"

echo "== 结束与总结 =="
curl -s -o /dev/null -X POST "$BASE/practice/$P/end" -H "Authorization: Bearer $STU"
check "结束后状态为已结束" "$(sql "SELECT status AS s FROM attempts WHERE attempt_id='$P';" | jq -r '.[0].results[0].s')" "已结束"
check "已结束的练习不能再取题(409)" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/practice/$P/next" -H "Authorization: Bearer $STU")" "409"
SUM=$(au "$BASE/practice/$P/summary")
check "总结含做题数" "$(echo "$SUM" | jq -r '.stats.answered > 0')" "true"
check "总结含正确率" "$(echo "$SUM" | jq -r '.stats.accuracy != null')" "true"
check "总结列出考点掌握档位" "$(echo "$SUM" | jq -r '.knowledgePoints | length > 0')" "true"
check "总结给出学习建议" "$(echo "$SUM" | jq -r '.suggestions | length > 0')" "true"
check "总结识别出薄弱考点" "$(echo "$SUM" | jq -r '.weakPoints | length > 0')" "true"
check "档位取值合法" \
  "$(echo "$SUM" | jq -r '[.knowledgePoints[].tier] | map(select(. != "已掌握" and . != "待巩固" and . != "薄弱" and . != "未测")) | length')" "0"

echo "== 单考点专项 =="
TAG=$(echo "$SUM" | jq -r '.weakPoints[0].tagId')
D=$(curl -s -X POST "$BASE/practice/drill" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d "$(jq -n --arg c 13000 --arg t "$TAG" '{courseCode:$c,tagId:$t}')")
DID=$(echo "$D" | jq -r '.attemptId')
check "创建单考点专项" "$(echo "$D" | jq -r '.stage')" "单考点专项"
TOTAL=$(echo "$D" | jq -r '.questionCount')
check "取到该考点下的全部题目" "$(( TOTAL > 0 ))" "1"
N=$(au "$BASE/practice/$DID/next")
QID=$(echo "$N" | jq -r '.question.questionId')
check "专项出的题确实带该考点" \
  "$(sql "SELECT COUNT(*) AS n FROM question_knowledge_points WHERE question_id='$QID' AND tag_id='$TAG';" | jq -r '.[0].results[0].n > 0')" "true"
check "专项阶段标记正确" "$(echo "$N" | jq -r '.stage')" "单考点专项"

echo "== 越权与恢复 =="
check "别人的练习读不到(403)" \
  "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/practice/$DID/next" -H "Authorization: Bearer $STU2")" "403"
check "未登录取题(401)" "$(curl -s -o /dev/null -w '%{http_code}' "$BASE/practice/$DID/next")" "401"
ACTIVE=$(au "$BASE/practice/active?courseCode=13000")
check "能找回未完成的练习" "$(echo "$ACTIVE" | jq -r '.active.attempt_id')" "$DID"

echo "== 练习不计入模考历史 =="
check "历史里练习与模考都在但可区分" \
  "$(au "$BASE/history" | jq -r '[.attempts[] | select(.mode=="PRACTICE")] | length >= 2')" "true"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
