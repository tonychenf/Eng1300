#!/usr/bin/env bash
# 改进阶段 2 第三期·AI 拆题导入的服务端（PRD 7.1）：建任务、传页（图进 KV 不进 D1）、开始、
# cron 排队识别（失败重试、可疑页当场第二遍、识别完图即删）、拆题（跨段并回、拆坏了整份失败可重拆）、
# 体检、核对（改题记字段、点没问题、整页没问题、重拍只重识别这一页）、入库（字段、出自第几页）、放弃、花费与上限。
#
# 替身看不懂图：测试把要回什么埋在"照片"的字节里（STUBPAGE:<转写稿页码>:<改几个字母>[:garble][:bad] / STUBFAIL），
# 期望的题数、页码从转写稿（worker/src/ocr-bench/truth-data.js）现算。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8768          # 端口表见 CLAUDE.md
STUB_PORT=8885
ROOT="http://127.0.0.1:$PORT"
BASE="$ROOT/api"
STUB="http://127.0.0.1:$STUB_PORT"
WORK=$(mktemp -d)
PASS=0; FAIL=0
PIN=1; POUT=2      # 读图单价（元 / 百万 tokens）；替身每次识别回 1000 / 500 tokens
TIN=3; TOUT=4      # 拆题单价；替身每次拆题回 2000 / 1000 tokens

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
JWT_SECRET=test-secret-ph2imp
SETUP_TOKEN=test-setup-ph2imp
ENCRYPTION_KEY=test-encryption-key-ph2imp
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "迁移 $m 失败"; exit 1; }
done

echo "== 启动 AI 替身与服务（--test-scheduled：用 /__scheduled 手动触发每分钟那一次）=="
node test/ai-stub.mjs "$STUB_PORT" > /tmp/ph2-import-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/ph2-import-dev.log
setsid npx wrangler dev --local --test-scheduled --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
ready=0
for i in $(seq 1 150); do curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1; done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-ph2imp' -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
PW=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"username":"IMP01","subjects":[]}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "$(jq -n --arg p "$PW" '{username:"IMP01",password:$p}')" | jq -r '.token')

code() { curl -s -o "$WORK/last.json" -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
A() { curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$@"; }
# 用 miniflare 自己的 /cdn-cgi/local/scheduled：/__scheduled 被静态资源（SPA 回落）接走了，到不了 Worker
tick() { curl -s -m 300 -o /dev/null "$ROOT/cdn-cgi/local/scheduled?cron=*+*+*+*+*"; }
img() { printf 'data:image/jpeg;base64,%s' "$(printf '\xff\xd8\xff%s' "$1" | base64 -w0)"; }
put_page() { code -X PUT "$BASE/admin/import/jobs/$1/pages/$2" -H "Authorization: Bearer $ADMIN" -d "$(jq -nc --arg i "$(img "$3")" '{image:$i}')"; }
kv_keys() { npx wrangler kv key list --binding IMPORT_IMAGES --local 2>/dev/null | jq -r 'length'; }
stats() { curl -s "$STUB/stats"; }

# 期望值从转写稿现算：第 121、122、123 页各有几道题、题号从几到几
read -r N121 N122 N123 LAST122 LAST123 < <(node -e "
import('./src/ocr-bench/truth-data.js').then(({ TRUTH_PAGES }) => {
  const q = (p) => TRUTH_PAGES.find((x) => x.page === p).questions;
  console.log(q(121).length, q(122).length, q(123).length, q(122).at(-1), q(123).at(-1));
});")
echo "  （转写稿：第 121 页 $N121 题、第 122 页 $N122 题（到第 $LAST122 题）、第 123 页 $N123 题（到第 $LAST123 题））"

echo
echo "== 配置：读图用 stub-import、拆题用 stub-split，都带单价 =="
A -X PUT "$BASE/admin/ai/settings/PARSING" -d "$(jq -n --arg u "$STUB/v1" --argjson pi $PIN --argjson po $POUT '{baseUrl:$u,apiKey:"stub-key",model:"stub-import",visionCapable:true,priceInPerM:$pi,priceOutPerM:$po}')" >/dev/null
A -X PUT "$BASE/admin/ai/settings/TEXT_PARSING" -d "$(jq -n --arg u "$STUB/v1" --argjson pi $TIN --argjson po $TOUT '{baseUrl:$u,apiKey:"stub-key",model:"stub-split",priceInPerM:$pi,priceOutPerM:$po}')" >/dev/null

echo
echo "== 权限 =="
for spec in "GET /admin/import/jobs" "POST /admin/import/jobs" "GET /admin/import/jobs/x" "PUT /admin/import/jobs/x/pages/1" \
            "POST /admin/import/jobs/x/start" "PATCH /admin/import/jobs/x/questions/q1" "POST /admin/import/jobs/x/issues/resolve" \
            "POST /admin/import/jobs/x/pages/1/ok" "PUT /admin/import/jobs/x/pages/1/retake" "POST /admin/import/jobs/x/commit" \
            "POST /admin/import/jobs/x/abandon" "POST /admin/import/jobs/x/resplit" "DELETE /admin/import/jobs/x/questions/q1"; do
  set -- $spec
  check "学员令牌调 $1 $2 → 403" "$(code -X "$1" "$BASE$2" -H "Authorization: Bearer $STU" -d '{}')" "403"
done
check "不存在的任务 → 404" "$(code "$BASE/admin/import/jobs/imp-nope" -H "Authorization: Bearer $ADMIN")" "404"
check "不存在的学科 → 404" "$(code -X POST "$BASE/admin/import/jobs" -H "Authorization: Bearer $ADMIN" -d '{"subjectCode":"nope"}')" "404"

echo
echo "== 建任务、传页：图进 KV，D1 只记键 =="
check "建任务 → 201、状态上传中、没写名字给一个默认名" \
  "$(code -X POST "$BASE/admin/import/jobs" -H "Authorization: Bearer $ADMIN" -d '{"subjectCode":"pubeng"}')/$(jq -r '"\(.status)/\(.title | test("公共英语 导入"))"' "$WORK/last.json")" "201/上传中/true"
JOB=$(jq -r '.id' "$WORK/last.json")
check "传第 1 张（第 121 页）→ 200" "$(put_page "$JOB" 1 'STUBPAGE:121:0')" "200"
check "传第 2 张（第 122 页，改 3 个字母、第 2 行出乱码）→ 200" "$(put_page "$JOB" 2 'STUBPAGE:122:3:garble')" "200"
check "传第 3 张（识别会失败）→ 200" "$(put_page "$JOB" 3 'STUBFAIL')" "200"
check "第 0 张、第 51 张 → 400" "$(put_page "$JOB" 0 'x')/$(put_page "$JOB" 51 'x')" "400/400"
check "不是图片 → 400" "$(code -X PUT "$BASE/admin/import/jobs/$JOB/pages/4" -H "Authorization: Bearer $ADMIN" -d '{"image":"data:text/plain;base64,aGk="}')" "400"
check "KV 里排着 3 张图" "$(kv_keys)" "3"
check "D1 里只有键，没有图" "$(one "SELECT COUNT(*) || '/' || SUM(image_key IS NOT NULL) FROM import_pages WHERE job_id = '$JOB';")/$(one "SELECT COUNT(*) FROM import_pages WHERE text LIKE '%data:image%' OR image_key LIKE '%base64%';")" "3/3/0"

echo
echo "== 开始：页序要连着、本月到上限要明说继续 =="
GAP=$(A -X POST "$BASE/admin/import/jobs" -d '{"subjectCode":"pubeng","title":"缺页的"}' | jq -r '.id')
put_page "$GAP" 1 'STUBPAGE:121:0' >/dev/null; put_page "$GAP" 3 'STUBPAGE:123:0' >/dev/null
check "中间缺一张 → 422 page_gap" "$(code -X POST "$BASE/admin/import/jobs/$GAP/start" -H "Authorization: Bearer $ADMIN" -d '{}')/$(jq -r '.error' "$WORK/last.json")" "422/page_gap"
A -X POST "$BASE/admin/import/jobs/$GAP/abandon" >/dev/null
# 本月先记 1 元的花费（这时还没调过模型），再把上限设成 0.0001 元
exec_sql "INSERT OR REPLACE INTO ai_spend_monthly (month, cost_yuan, calls, calls_without_price) VALUES (strftime('%Y-%m', 'now', '+8 hours'), 1, 1, 0);"
A -X PUT "$BASE/admin/ai/budget" -d '{"yuan":0.0001}' >/dev/null
check "到了上限、不说继续 → 409 over_budget" "$(code -X POST "$BASE/admin/import/jobs/$JOB/start" -H "Authorization: Bearer $ADMIN" -d '{}')/$(jq -r '.error' "$WORK/last.json")" "409/over_budget"
check "说继续 → 200，审计记下是超额开始的" \
  "$(code -X POST "$BASE/admin/import/jobs/$JOB/start" -H "Authorization: Bearer $ADMIN" -d '{"confirmOverBudget":true,"estimateYuan":0.01}')/$(one "SELECT COUNT(*) FROM admin_audit WHERE action = 'import_job.start_over_budget' AND target = '$JOB';")" "200/1"
A -X PUT "$BASE/admin/ai/budget" -d '{"yuan":null}' >/dev/null
check "开始之后不能再加页 → 409" "$(put_page "$JOB" 4 'STUBPAGE:123:0')" "409"

echo
echo "== 后台排队识别（cron）=="
curl -s -o /dev/null "$STUB/stats?reset=1"
tick
check "第一次醒来：第 1、2 张识别了，第 3 张失败一次、放回排队" \
  "$(one "SELECT group_concat(page_no || ':' || status || ':' || attempts, ',') FROM (SELECT * FROM import_pages WHERE job_id = '$JOB' ORDER BY page_no);")" "1:已识别:1,2:已识别:1,3:待识别:1"
check "读出了书上印的页码" "$(one "SELECT group_concat(printed_page, ',') FROM (SELECT * FROM import_pages WHERE job_id = '$JOB' AND printed_page IS NOT NULL ORDER BY page_no);")" "121,122"
check "第 2 张有乱码：趁图还在用另一个提示词再识别了一遍（只有这一张）" \
  "$(stats | jq -r '[.importOcrCalls[] | select(endswith("#alt"))] | join(",")')" "STUBPAGE:122:3:garble#alt"
check "两次识别不一致的地方记下来了" "$(one "SELECT json_array_length(issues_json, '\$.altDiffs') > 0 FROM import_pages WHERE job_id = '$JOB' AND page_no = 2;")" "1"
check "识别完的两张图已经从 KV 删了，失败待重试的那张还在" "$(kv_keys)/$(one "SELECT group_concat(page_no) FROM import_pages WHERE job_id = '$JOB' AND image_key IS NOT NULL;")" "1/3"
tick; tick
check "第 3 张连失败 3 次：标失败、图也删了" "$(one "SELECT status || ':' || attempts || ':' || (image_key IS NULL) FROM import_pages WHERE job_id = '$JOB' AND page_no = 3;")/$(kv_keys)" "失败:3:1/0"
check "页都有结果了 → 拆题 → 待核对" "$(one "SELECT status FROM import_jobs WHERE job_id = '$JOB';")" "待核对"
A "$BASE/admin/import/jobs/$JOB" > "$WORK/job.json"
check "拆出来的题数 = 第 121、122 页转写稿的题数（$N121 + $N122）" "$(jq -r '[.draft.sections[].questions[]] | length' "$WORK/job.json")" "$((N121 + N122))"
check "两页拆出来的题接成一部分、题号从 1 连到 $LAST122" \
  "$(jq -r '"\(.draft.sections | length)/\([.draft.sections[0].questions[].no] | first)-\([.draft.sections[0].questions[].no] | last)"' "$WORK/job.json")" "1/1-$LAST122"
WANT_COST=$(awk -v a=$PIN -v b=$POUT -v c=$TIN -v d=$TOUT 'BEGIN { printf "%.6f", (3*(1000*a + 500*b) + (2000*c + 1000*d)) / 1e6 }')
check "花费 = 识别 3 次（含第二遍）+ 拆题 1 次，按各自单价现算 = $WANT_COST 元" "$(one "SELECT printf('%.6f', cost_yuan) FROM import_jobs WHERE job_id = '$JOB';")" "$WANT_COST"
check "可疑处：失败的那张、乱码那一行、两次识别不一致都在" \
  "$(jq -r '[.issues[].rule] | (index("failed") != null) and (index("garbled") != null) and (index("double") != null)' "$WORK/job.json")" "true"

echo
echo "== 核对：可疑处没处理完不能入库 =="
check "入库 → 409 issues_pending" "$(code -X POST "$BASE/admin/import/jobs/$JOB/commit" -H "Authorization: Bearer $ADMIN" -d '{}')/$(jq -r '.error' "$WORK/last.json")" "409/issues_pending"
QID=$(jq -r '.draft.sections[0].questions[1].id' "$WORK/job.json")
check "改第 2 题的题干 → 200，记下改了 stem" \
  "$(code -X PATCH "$BASE/admin/import/jobs/$JOB/questions/$QID" -H "Authorization: Bearer $ADMIN" -d '{"stem":"改过的题干 ____."}')/$(jq -r '.changed | join(",")' "$WORK/last.json")" "200/stem"
check "题型改成这门课没有的 → 400" "$(code -X PATCH "$BASE/admin/import/jobs/$JOB/questions/$QID" -H "Authorization: Bearer $ADMIN" -d '{"questionType":"nope"}')" "400"
check "改一道不存在的题 → 404" "$(code -X PATCH "$BASE/admin/import/jobs/$JOB/questions/q999" -H "Authorization: Bearer $ADMIN" -d '{"stem":"x"}')" "404"

echo
echo "== 重拍：只重新识别、重新拆这一页 =="
check "重拍第 3 张（换成第 123 页）→ 200，任务回到识别中" \
  "$(code -X PUT "$BASE/admin/import/jobs/$JOB/pages/3/retake" -H "Authorization: Bearer $ADMIN" -d "$(jq -nc --arg i "$(img 'STUBPAGE:123:0')" '{image:$i}')")/$(one "SELECT status FROM import_jobs WHERE job_id = '$JOB';")" "200/识别中"
curl -s -o /dev/null "$STUB/stats?reset=1"
tick
check "只识别了第 3 张这一张、拆题只拆这一页" "$(stats | jq -r '"\(.importOcrCalls | join(","))/\(.splitCalls)"')" "STUBPAGE:123:0/1"
A "$BASE/admin/import/jobs/$JOB" > "$WORK/job.json"
check "回到待核对；题数加上第 123 页的 $N123 题，题号连到 $LAST123" \
  "$(jq -r '"\(.job.status)/\([.draft.sections[].questions[]] | length)/\([.draft.sections[].questions[].no] | max)"' "$WORK/job.json")" "待核对/$((N121 + N122 + N123))/$LAST123"
check "前两页改过的字还在（重拍不碰别的页）" "$(jq -r --arg q "$QID" '[.draft.sections[].questions[] | select(.id == $q) | .stem] | first' "$WORK/job.json")" "改过的题干 ____."
check "失败那张的可疑处没了" "$(jq -r '[.issues[] | select(.rule == "failed")] | length' "$WORK/job.json")" "0"

echo
echo "== 处理可疑处、入库 =="
IDS=$(jq -c '[.issues[] | select(.resolved | not) | select(.rule != "garbled") | .id]' "$WORK/job.json")
check "逐条点没问题 → 200" "$(code -X POST "$BASE/admin/import/jobs/$JOB/issues/resolve" -H "Authorization: Bearer $ADMIN" -d "{\"ids\":$IDS}")" "200"
check "乱码那条没点：还剩可疑" "$(A "$BASE/admin/import/jobs/$JOB" | jq -r '.pendingIssues > 0')" "true"
check "第 2 张点「这页没问题」→ 可疑处清零" "$(code -X POST "$BASE/admin/import/jobs/$JOB/pages/2/ok" -H "Authorization: Bearer $ADMIN")/$(A "$BASE/admin/import/jobs/$JOB" | jq -r '.pendingIssues')" "200/0"
check "入库 → 200" "$(code -X POST "$BASE/admin/import/jobs/$JOB/commit" -H "Authorization: Bearer $ADMIN" -d '{}')" "200"
jq -e '.examId' "$WORK/last.json" >/dev/null 2>&1 || echo "    （入库的回应：$(head -c 400 "$WORK/last.json")）"
EXAM=$(jq -r '.examId' "$WORK/last.json")
check "任务已入库、记下内容组" "$(one "SELECT status || ':' || exam_id FROM import_jobs WHERE job_id = '$JOB';")" "已入库:$EXAM"
check "内容组是上传来源、题数对、答案缺（等出答案）" \
  "$(one "SELECT e.origin || ':' || COUNT(q.question_id) || ':' || MIN(q.answer_state) || MAX(q.answer_state) FROM exams e JOIN questions q ON q.exam_id = e.exam_id WHERE e.exam_id = '$EXAM';")" "UPLOAD:$((N121 + N122 + N123)):缺答案缺答案"
check "每道题记下出自书上第几页（121、122、123 各自的题数）" \
  "$(one "SELECT group_concat(source_page || '=' || n, ',') FROM (SELECT source_page, COUNT(*) AS n FROM questions WHERE exam_id = '$EXAM' GROUP BY source_page ORDER BY source_page);")" "121=$N121,122=$N122,123=$N123"
check "改过的那道记下了 edited_fields，别的没有" \
  "$(one "SELECT COUNT(*) || ':' || MAX(edited_fields) FROM questions WHERE exam_id = '$EXAM' AND edited_fields IS NOT NULL;")" '1:["stem"]'
check "选项照原样入库（A. … 那种）" "$(one "SELECT json_extract(options, '\$[0]') LIKE 'A. %' FROM questions WHERE exam_id = '$EXAM' ORDER BY question_id LIMIT 1;")" "1"
check "入库之后不能再改、不能放弃" \
  "$(code -X PATCH "$BASE/admin/import/jobs/$JOB/questions/$QID" -H "Authorization: Bearer $ADMIN" -d '{"stem":"x"}')/$(code -X POST "$BASE/admin/import/jobs/$JOB/abandon" -H "Authorization: Bearer $ADMIN")" "409/409"
check "删掉这个内容组：任务记录留着、不再指向它" \
  "$(code -X DELETE "$BASE/admin/bank/exams/$EXAM" -H "Authorization: Bearer $ADMIN")/$(one "SELECT status || ':' || IFNULL(exam_id, '空') FROM import_jobs WHERE job_id = '$JOB';")" "200/已入库:空"

echo
echo "== 拆坏了：整份失败、文字留着、可以重拆 =="
BADJ=$(A -X POST "$BASE/admin/import/jobs" -d '{"subjectCode":"pubeng","title":"拆不了的"}' | jq -r '.id')
put_page "$BADJ" 1 'STUBPAGE:121:0:bad' >/dev/null
A -X POST "$BASE/admin/import/jobs/$BADJ/start" -d '{}' >/dev/null
curl -s -o /dev/null "$STUB/stats?reset=1"
tick
check "形状不对：重试一次（共 2 次）后整份失败、说清拆题失败" \
  "$(stats | jq -r '.splitCalls')/$(one "SELECT status || ':' || (error LIKE '%拆题失败%') FROM import_jobs WHERE job_id = '$BADJ';")" "2/失败:1"
check "识别出的文字留着" "$(one "SELECT length(text) > 100 FROM import_pages WHERE job_id = '$BADJ';")" "1"
check "重拆 → 回到识别中，下一次醒来再拆" "$(code -X POST "$BASE/admin/import/jobs/$BADJ/resplit" -H "Authorization: Bearer $ADMIN")/$(one "SELECT status FROM import_jobs WHERE job_id = '$BADJ';")" "200/识别中"

echo
echo "== 放弃：排队的图一并删掉 =="
AB=$(A -X POST "$BASE/admin/import/jobs" -d '{"subjectCode":"pubeng","title":"放弃的"}' | jq -r '.id')
put_page "$AB" 1 'STUBPAGE:121:0' >/dev/null; put_page "$AB" 2 'STUBPAGE:122:0' >/dev/null
BEFORE=$(kv_keys)
check "放弃 → 200，删了 2 张图" "$(code -X POST "$BASE/admin/import/jobs/$AB/abandon" -H "Authorization: Bearer $ADMIN")/$(jq -r '.imagesDeleted' "$WORK/last.json")/$((BEFORE - $(kv_keys)))" "200/2/2"
check "放弃过的不能再放弃 → 409" "$(code -X POST "$BASE/admin/import/jobs/$AB/abandon" -H "Authorization: Bearer $ADMIN")" "409"
check "列表里看得到各个任务和状态" "$(A "$BASE/admin/import/jobs?subjectCode=pubeng" | jq -r --arg a "$AB" '[.jobs[] | select(.job_id == $a) | .status] | first')" "已放弃"
check "D1 里从头到尾没有图片内容" "$(one "SELECT COUNT(*) FROM import_pages WHERE text LIKE '%base64%' OR text_alt LIKE '%base64%';")/$(one "SELECT COUNT(*) FROM import_jobs WHERE draft_json LIKE '%data:image%';")" "0/0"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
exit $([ "$FAIL" = 0 ] && echo 0 || echo 1)
