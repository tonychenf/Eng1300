#!/usr/bin/env bash
# 改进阶段 2 第三期 D·批量核答案的服务端（PRD 7.2）：拍照导入一章（带书上手写答案）→ AI 出答案（顺带把握、题面有没有问题）→
# 核答案队列按疑点排（题面有问题 → 和书上不一致 → 拿不准 → 其余）→ 传原书答案页比对（一致的确认、不一致的排前、题面坏的不替人确认）
# → 其余整组确认（混进来的有疑点的、自检过不了的留下）→ 核对单 → 删内容组连疑点一起删。
#
# 替身看不懂图：要回什么埋在"照片"字节里（STUBPAGE:<页>:<k>[:hand<题号><答案>] / STUBANS:<起>-<止>:<答案>[:<另一个>@<题号>,…]）。
# 替身出选择题答案一律回第一个选项（A）；题干里写【低把握】【题面坏】它就照回"把握低""题面有问题"。
# 期望的题数从转写稿（worker/src/ocr-bench/truth-data.js）现算。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8765          # 端口表见 CLAUDE.md
STUB_PORT=8881
ROOT="http://127.0.0.1:$PORT"
BASE="$ROOT/api"
STUB="http://127.0.0.1:$STUB_PORT"
WORK=$(mktemp -d)
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc";
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill -- "-$SERVER_PID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$ROOT_DIR/.wrangler" "$WORK"
  rm -f .dev.vars
}
trap cleanup EXIT
source "$ROOT_DIR/test/lib/d1.sh"
[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }

echo "== 准备：迁移 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-ph2ans
SETUP_TOKEN=test-setup-ph2ans
ENCRYPTION_KEY=test-encryption-key-ph2ans
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "迁移 $m 失败"; exit 1; }
done

echo "== 启动 AI 替身与服务 =="
node test/ai-stub.mjs "$STUB_PORT" > /tmp/ph2-answers-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/ph2-answers-dev.log
setsid npx wrangler dev --local --test-scheduled --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
ready=0
for i in $(seq 1 150); do curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1; done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-ph2ans' -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
PW=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"username":"ANS01","subjects":[]}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "$(jq -n --arg p "$PW" '{username:"ANS01",password:$p}')" | jq -r '.token')

code() { curl -s -o "$WORK/last.json" -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
A() { curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$@"; }
tick() { curl -s -m 300 -o /dev/null "$ROOT/cdn-cgi/local/scheduled?cron=*+*+*+*+*"; }
img() { printf 'data:image/jpeg;base64,%s' "$(printf '\xff\xd8\xff%s' "$1" | base64 -w0)"; }
put_page() { code -X PUT "$BASE/admin/import/jobs/$1/pages/$2" -H "Authorization: Bearer $ADMIN" -d "$(jq -nc --arg i "$(img "$3")" '{image:$i}')"; }
answer_page() { code -X POST "$BASE/admin/bank/exams/$1/answer-page" -H "Authorization: Bearer $ADMIN" -d "$(jq -nc --arg i "$(img "$2")" '{image:$i}')"; }
queue() { A "$BASE/admin/bank/exams/$1/answer-queue"; }

N=$(node -e "import('./src/ocr-bench/truth-data.js').then(({ TRUTH_PAGES }) => console.log(TRUTH_PAGES.find((x) => x.page === 121).questions.length))")
echo "  （转写稿第 121 页 $N 题）"
[ "$N" -ge 12 ] || { echo "第 121 页不到 12 题，下面挑的题号不够用"; exit 1; }
# 挑的几道题（题号都在 1..N 里）：
#   第 2 题  书上手写 B（AI 答 A → 不一致）     第 4 题  书上手写 A（和 AI 一样 → 不算疑点）
#   第 6 题  题干带【低把握】→ AI 说拿不准       第 8 题  题干带【题面坏】→ AI 说题面有问题
#   第 12 题 之后把题型改成按采分点批的「词组翻译」、又没有采分点 → 整组确认时标准答案自检过不了
# 答案页只有第 1–10 题，第 2、5 题书上是 B（AI 是 A）

echo
echo "== 配置：读图 stub-import、出答案 / 拆题走文字解析那一档 =="
A -X PUT "$BASE/admin/ai/settings/PARSING" -d "$(jq -n --arg u "$STUB/v1" '{baseUrl:$u,apiKey:"stub-key",model:"stub-import",visionCapable:true,priceInPerM:1,priceOutPerM:2}')" >/dev/null
A -X PUT "$BASE/admin/ai/settings/TEXT_PARSING" -d "$(jq -n --arg u "$STUB/v1" '{baseUrl:$u,apiKey:"stub-key",model:"stub-split"}')" >/dev/null

echo
echo "== 拍照导入一章：第 121 页，书上第 2、4 题旁边有手写答案 =="
JOB=$(A -X POST "$BASE/admin/import/jobs" -d '{"subjectCode":"pubeng","title":"核答案用的一章"}' | jq -r '.id')
put_page "$JOB" 1 'STUBPAGE:121:0:hand2B:hand4A' >/dev/null
A -X POST "$BASE/admin/import/jobs/$JOB/start" -d '{}' >/dev/null
tick; tick
A "$BASE/admin/import/jobs/$JOB" > "$WORK/job.json"
check "拆出 $N 题、第 2、4 题带着手写答案" \
  "$(jq -r '[.draft.sections[].questions[]] | "\(length)/\(map(select(.handwrittenAnswer != null) | "\(.no)=\(.handwrittenAnswer)") | join(","))"' "$WORK/job.json")" "$N/2=B,4=A"
for spec in "6:【低把握】" "8:【题面坏】"; do
  no=${spec%%:*}; mark=${spec#*:}
  qid=$(jq -r --argjson n "$no" '[.draft.sections[].questions[] | select(.no == $n) | .id] | first' "$WORK/job.json")
  stem=$(jq -r --argjson n "$no" '[.draft.sections[].questions[] | select(.no == $n) | .stem] | first' "$WORK/job.json")
  A -X PATCH "$BASE/admin/import/jobs/$JOB/questions/$qid" -d "$(jq -nc --arg s "$stem$mark" '{stem:$s}')" >/dev/null
done
IDS=$(A "$BASE/admin/import/jobs/$JOB" | jq -c '[.issues[] | select(.resolved | not) | .id]')
A -X POST "$BASE/admin/import/jobs/$JOB/issues/resolve" -d "{\"ids\":$IDS}" >/dev/null
check "入库 → 200" "$(code -X POST "$BASE/admin/import/jobs/$JOB/commit" -H "Authorization: Bearer $ADMIN" -d '{}')" "200"
EXAM=$(jq -r '.examId' "$WORK/last.json")
qid_of() { one "SELECT question_id FROM questions WHERE exam_id = '$EXAM' AND ord = $1;"; }
check "手写答案进了疑点表（只有第 2、4 题）" \
  "$(one "SELECT group_concat(q.ord || '=' || f.handwritten, ',') FROM (SELECT * FROM answer_review_flags ORDER BY question_id) f JOIN questions q ON q.question_id = f.question_id WHERE q.exam_id = '$EXAM' AND f.handwritten IS NOT NULL;")" "2=B,4=A"

echo
echo "== 权限 =="
for spec in "GET /admin/bank/exams/$EXAM/answer-queue" "POST /admin/bank/exams/$EXAM/confirm-rest" \
            "POST /admin/bank/exams/$EXAM/answer-page" "GET /admin/bank/exams/$EXAM/checklist"; do
  set -- $spec
  check "学员令牌调 $1 ${2/$EXAM/:examId} → 403" "$(code -X "$1" "$BASE$2" -H "Authorization: Bearer $STU" -d '{}')" "403"
done
for spec in "GET /answer-queue" "POST /confirm-rest" "POST /answer-page" "GET /checklist"; do
  set -- $spec
  check "不存在的内容组 $1 $2 → 404" "$(code -X "$1" "$BASE/admin/bank/exams/nope$2" -H "Authorization: Bearer $ADMIN" -d '{"ids":["x"],"image":"data:image/jpeg;base64,AA=="}')" "404"
done

echo
echo "== 还没出答案：每道都是「还没答案」 =="
queue "$EXAM" > "$WORK/q.json"
check "共 $N 题、有疑点 $N、其余 0，疑点都是 missing" \
  "$(jq -r '"\(.total)/\(.flagged | length)/\(.rest | length)/\([.flagged[].reasons[].kind] | unique | join(","))"' "$WORK/q.json")" "$N/$N/0/missing"

echo
echo "== AI 出答案：顺带回把握、题面有没有问题 =="
check "出答案 → 200" "$(code -X POST "$BASE/admin/bank/exams/$EXAM/ai-answers" -H "Authorization: Bearer $ADMIN" -d '{}')" "200"
check "出答案的提示里要了 confidence 和 stemProblem" \
  "$(curl -s "$STUB/last-prompt" | jq -r '.prompt | (contains("confidence") and contains("stemProblem"))')" "true"
check "把握：第 6 题低、其余高；题面有问题的只有第 8 题" \
  "$(one "SELECT group_concat(CASE WHEN f.confidence = '低' THEN q.ord END) || '/' || SUM(f.confidence = '高') || '/' || group_concat(CASE WHEN f.stem_problem IS NOT NULL THEN q.ord END) FROM answer_review_flags f JOIN questions q ON q.question_id = f.question_id WHERE q.exam_id = '$EXAM';")" "6/$((N - 1))/8"
check "手写答案没被出答案冲掉" "$(one "SELECT handwritten FROM answer_review_flags WHERE question_id = '$(qid_of 2)';")" "B"

queue "$EXAM" > "$WORK/q.json"
check "有疑点的排序：题面有问题（8）→ 和书上手写不一致（2）→ 拿不准（6）；手写一致的第 4 题不算" \
  "$(jq -r '[.flagged[].ord] | join(",")' "$WORK/q.json")" "8,2,6"
check "每道的疑点种类" "$(jq -r '[.flagged[] | "\(.ord):\([.reasons[].kind] | join("+"))"] | join(",")' "$WORK/q.json")" "8:stem,2:hand,6:unsure"
check "疑点说清手写的和 AI 的各是什么" "$(jq -r '.flagged[1].reasons[0].text | (contains("「B」") and contains("「A」"))' "$WORK/q.json")" "true"
check "其余 $((N - 3)) 题没有疑点" "$(jq -r '.rest | length' "$WORK/q.json")" "$((N - 3))"

echo
echo "== 原书答案页：第 1–10 题，第 2、5 题书上是 B =="
check "图不对 → 400" "$(code -X POST "$BASE/admin/bank/exams/$EXAM/answer-page" -H "Authorization: Bearer $ADMIN" -d '{"image":"data:text/plain;base64,aGk="}')" "400"
check "识别失败 → 422，一道都不动" \
  "$(answer_page "$EXAM" 'STUBFAIL')/$(one "SELECT COUNT(*) FROM questions WHERE exam_id = '$EXAM' AND answer_state = '已确认';")" "422/0"
check "比对 → 200：读出 10 题、比了 10 题、一致 8、不一致的是第 2、5 题" \
  "$(answer_page "$EXAM" 'STUBANS:1-10:A:B@2,5')/$(jq -r '"\(.read)/\(.compared)/\(.same)/\([.diff[].ord] | join(","))"' "$WORK/last.json")" "200/10/10/8/2,5"
check "一致率 0.8；第 8 题答案一致但题面有问题、没替人确认" "$(jq -r '"\(.rate)/\(.stemKept | join(","))"' "$WORK/last.json")" "0.8/8"
check "一致的确认了（10 题去掉不一致的 2 道、题面坏的 1 道 = 7 道），依据写明是原书比对" \
  "$(one "SELECT COUNT(*) || '/' || SUM(answer_reviewed_by LIKE '%与原书答案页一致%') FROM questions WHERE exam_id = '$EXAM' AND answer_state = '已确认';")" "7/7"
check "第 6 题（拿不准）因为书上一致被确认了；第 8 题还是待核" \
  "$(one "SELECT answer_state FROM questions WHERE question_id = '$(qid_of 6)';")/$(one "SELECT answer_state FROM questions WHERE question_id = '$(qid_of 8)';")" "已确认/待核"
check "审计记下一笔原书比对" "$(one "SELECT json_extract(after_json, '\$.same') FROM admin_audit WHERE action = 'answers.answer_page' AND target = '$EXAM';")" "8"

queue "$EXAM" > "$WORK/q.json"
check "队列：已确认 7；有疑点的 8 → 2 → 5（第 5 题和原书不一致）" \
  "$(jq -r '"\(.confirmed)/\([.flagged[].ord] | join(","))"' "$WORK/q.json")" "7/8,2,5"
check "第 2 题手写、原书两样都对不上" "$(jq -r '[.flagged[] | select(.ord == 2) | .reasons[].kind] | sort | join("+")' "$WORK/q.json")" "book+hand"
check "队列头上报与原书一致率（比了 10 题）" "$(jq -r '"\(.bookCompare.compared)/\(.bookCompare.same)"' "$WORK/q.json")" "10/8"

echo
echo "== 其余整组确认：混进来的有疑点的、自检过不了的留下 =="
exec_sql "UPDATE questions SET question_type = 'phrase_translate' WHERE question_id = '$(qid_of 12)';"
queue "$EXAM" > "$WORK/q.json"
REST=$(jq -c '[.rest[].questionId]' "$WORK/q.json")
NREST=$(jq -r '.rest | length' "$WORK/q.json")
check "其余里有第 12 题（自检过不过不算疑点，排队只看疑点）" "$(jq -r '[.rest[].ord] | index(12) != null' "$WORK/q.json")" "true"
check "名单为空 → 400" "$(code -X POST "$BASE/admin/bank/exams/$EXAM/confirm-rest" -H "Authorization: Bearer $ADMIN" -d '{"ids":[]}')" "400"
SMUGGLE=$(jq -nc --argjson r "$REST" --arg q "$(qid_of 8)" '$r + [$q]')
check "整组确认（名单里混进第 8 题）→ 200，确认 $((NREST - 1)) 题，留下第 8、12 题" \
  "$(code -X POST "$BASE/admin/bank/exams/$EXAM/confirm-rest" -H "Authorization: Bearer $ADMIN" -d "{\"ids\":$SMUGGLE}")/$(jq -r '"\(.confirmed)/\([.kept[].ord] | sort | join(","))"' "$WORK/last.json")" "200/$((NREST - 1))/8,12"
check "第 12 题留下的原因是自检：没有采分点" "$(jq -r '[.kept[] | select(.ord == 12) | .reason] | first | contains("没有采分点")' "$WORK/last.json")" "true"
check "第 8、12 题还是待核；确认的都有确认人" \
  "$(one "SELECT answer_state FROM questions WHERE question_id = '$(qid_of 8)';")/$(one "SELECT answer_state FROM questions WHERE question_id = '$(qid_of 12)';")/$(one "SELECT COUNT(*) FROM questions WHERE exam_id = '$EXAM' AND answer_state = '已确认' AND answer_reviewed_by IS NULL;")" "待核/待核/0"
check "已确认 = 7 + $((NREST - 1))" "$(one "SELECT COUNT(*) FROM questions WHERE exam_id = '$EXAM' AND answer_state = '已确认';")" "$((7 + NREST - 1))"
check "审计记下整组确认" "$(one "SELECT json_array_length(after_json, '\$.confirmed') FROM admin_audit WHERE action = 'answers.confirm_rest' AND target = '$EXAM';")" "$((NREST - 1))"

echo
echo "== 核对单：拿不准的排前 =="
H=$(curl -s -D - -o "$WORK/list.md" "$BASE/admin/bank/exams/$EXAM/checklist" -H "Authorization: Bearer $ADMIN" | tr -d '\r' | awk -F': ' 'tolower($1) == "content-type" {print $2}')
check "Markdown" "$H" "text/markdown; charset=utf-8"
rows() { grep '^| ' "$WORK/list.md" | grep -v '^| 题 |'; }   # 表头之外的每一行（分隔行是 |---|，不以"| "开头）
check "每道题一行（$N 行）" "$(rows | wc -l)" "$N"
check "第一行是题面有问题的第 8 题" "$(rows | head -1 | grep -c '第 8 题')" "1"
check "表头写着章名" "$(head -1 "$WORK/list.md")" "# 答案核对单：核答案用的一章"

echo
echo "== 一题一题：改了再确认，走校对页那个保存接口 =="
check "第 2 题改成 B 并确认 → 200" "$(code -X PATCH "$BASE/admin/bank/questions/$(qid_of 2)" -H "Authorization: Bearer $ADMIN" -d '{"answer":"B","answerState":"已确认"}')" "200"
check "第 5 题点「对」（保留 A）→ 200" "$(code -X PATCH "$BASE/admin/bank/questions/$(qid_of 5)" -H "Authorization: Bearer $ADMIN" -d '{"answerState":"已确认"}')" "200"
queue "$EXAM" > "$WORK/q.json"
check "剩下有疑点的只有第 8 题，其余只剩第 12 题" "$(jq -r '"\([.flagged[].ord] | join(","))/\([.rest[].ord] | join(","))"' "$WORK/q.json")" "8/12"

echo
echo "== 删内容组：疑点一起删 =="
check "删除 → 200，删了疑点表的行" "$(code -X DELETE "$BASE/admin/bank/exams/$EXAM" -H "Authorization: Bearer $ADMIN")/$(jq -r '.deleted.reviewFlags > 0' "$WORK/last.json")" "200/true"
check "疑点表里不剩这一章的" "$(one "SELECT COUNT(*) FROM answer_review_flags WHERE question_id LIKE '$EXAM%' OR question_id NOT IN (SELECT question_id FROM questions);")" "0"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
exit $([ "$FAIL" = 0 ] && echo 0 || echo 1)
