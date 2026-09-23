#!/usr/bin/env bash
# N5 得分单元：schema、题型的两个新维度、补列脚本的回填。
#
# 判分逻辑本身在 test/grade-items.test.mjs 里用构造数据测（纯 node，测得细）。
# 这一套只管**接口与数据库这一侧**：列在不在、后台能不能改、旧库补列之后回填对不对。
# 两边的分工不能混：判分规则拿服务端测，一条断言要等 100 秒起服务。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8788          # 端口表见 CLAUDE.md
BASE="http://localhost:$PORT/api"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

sql()  { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
exec_sql() { npx wrangler d1 execute "$D1_NAME" --local --command "$1" >/dev/null 2>&1; }
one()  { sql "$1" | jq -r '.[0].results[0] | to_entries[0].value // empty'; }
adm()  { curl -s -H "Authorization: Bearer $ADMIN" "$@"; }
admj() { curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$@"; }

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
JWT_SECRET=test-secret-n5
SETUP_TOKEN=test-setup-n5
ENCRYPTION_KEY=test-encryption-key-n5
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done

echo
echo "== 得分单元与结构化模板的表结构 =="
cols() { sql "SELECT group_concat(name) AS c FROM pragma_table_info('$1');" | jq -r '.[0].results[0].c // empty' | tr ',' '\n' | sort | tr '\n' ' '; }
for c in question_id item_ord subject_id item_kind grading_strategy group_key answer alt_answers weight params; do
  check "question_items 有 $c 列" "$(cols question_items | grep -cw "$c")" "1"
done
for c in course_code ord label filter question_count score_mode score_per_question pick_unit; do
  check "exam_template_items 有 $c 列" "$(cols exam_template_items | grep -cw "$c")" "1"
done
check "得分单元的主键是 (题目, 序号)" \
  "$(sql "SELECT group_concat(name) AS c FROM pragma_table_info('question_items') WHERE pk > 0;" | jq -r '.[0].results[0].c')" \
  "question_id,item_ord"
# 题目只带相对权重，不带绝对分值（§6.4.7）。真出现 score 列说明分值归属又回到题目上了
check "得分单元上没有绝对分值列" "$(cols question_items | grep -cw score)" "0"
check "answer_records 有 item_results 列" "$(cols answer_records | grep -cw item_results)" "1"
check "answer_records 有 score_rate 列" "$(cols answer_records | grep -cw score_rate)" "1"

echo
echo "== 英语的组卷模板照搬迁入，行为必须与 exam_templates 完全一致 =="
# 先确认旧表真有行：两张空表也能让下面的比对全绿，那测的是"迁移没跑"
check "旧表里确实有模板（否则下面几条是空断言）" \
  "$([ "$(one 'SELECT COUNT(*) FROM exam_templates;')" -ge 7 ] && echo 有 || echo 无)" "有"
check "模板项数与旧表一致" "$(one 'SELECT COUNT(*) FROM exam_template_items;')" "$(one 'SELECT COUNT(*) FROM exam_templates;')"
check "对不上的行数为 0" "$(one "
  SELECT COUNT(*) FROM exam_templates t LEFT JOIN exam_template_items i
    ON i.course_code = t.course_code AND i.ord = t.ord
   WHERE i.ord IS NULL OR i.question_count <> t.question_count
      OR i.score_per_question <> t.score_per_question
      OR i.filter <> '{\"sectionTypes\":[\"' || t.section_type || '\"]}';")" "0"
check "抽题单位全是整组抽（英语现状）" "$(one "SELECT COUNT(*) FROM exam_template_items WHERE pick_unit <> 'SECTION';")" "0"
check "配分方式全部来自模板" "$(one "SELECT COUNT(*) FROM exam_template_items WHERE score_mode <> 'FROM_TEMPLATE';")" "0"

echo
echo "== 题型的两个维度：作答形态 × 判分策略 =="
check "没有题型缺判分策略" "$(one 'SELECT COUNT(*) FROM subject_question_types WHERE grading_strategy IS NULL;')" "0"
check "没有题型缺作答形态" "$(one 'SELECT COUNT(*) FROM subject_question_types WHERE answer_shape IS NULL;')" "0"
# needs_ai 与策略要不要 AI 必须一致，否则交卷时的"待批改"计数与实际判分对不上
check "needs_ai 与策略一致" "$(one "
  SELECT COUNT(*) FROM subject_question_types
   WHERE (needs_ai = 1) <> (grading_strategy LIKE 'AI\\_%' ESCAPE '\\');")" "0"
check "英语写作是维度加权" "$(one "SELECT grading_strategy FROM subject_question_types
  WHERE type_code='essay' AND subject_id=(SELECT subject_id FROM subjects WHERE code='english');")" "AI_DIMENSION"
check "生化名词解释是采分点命中" "$(one "SELECT grading_strategy FROM subject_question_types
  WHERE type_code='term_explain' AND subject_id=(SELECT subject_id FROM subjects WHERE code='biochem');")" "AI_SCORE_POINTS"

echo
echo "== 补列脚本：只填 NULL，填不了就让部署失败 =="
OUT=$(bash "$ROOT_DIR/../scripts/ci/ensure-columns.sh" --local 2>&1)
check "新库上是空操作（不新增列）" "$(echo "$OUT" | grep -c '本次新增 0 列')" "1"
check "新库上没有要回填的行" "$(echo "$OUT" | grep -c '回填 0 行')" "1"
# 模拟旧库：把一行的策略清空，回填要把它补回来
exec_sql "UPDATE subject_question_types SET grading_strategy = NULL, answer_shape = NULL WHERE type_code='fill_text';"
BEFORE=$(one "SELECT COUNT(*) FROM subject_question_types WHERE grading_strategy IS NULL;")
check "先确认真的清空了" "$([ "$BEFORE" -ge 1 ] && echo 有 || echo 无)" "有"
OUT=$(bash "$ROOT_DIR/../scripts/ci/ensure-columns.sh" --local 2>&1)
check "回填跑了" "$(echo "$OUT" | grep -c '回填 subject_question_types.grading_strategy')" "1"
check "回填之后没有空值了" "$(one 'SELECT COUNT(*) FROM subject_question_types WHERE grading_strategy IS NULL;')" "0"
check "填回去的值是对的" "$(one "SELECT DISTINCT grading_strategy FROM subject_question_types WHERE type_code='fill_text';")" "EXACT"
# 对照表里没有的题型填不出来，这时必须让部署失败而不是留一个判不了分的学科
exec_sql "INSERT INTO subject_question_types (subject_id, type_code, name, sort_order)
  VALUES ((SELECT subject_id FROM subjects WHERE code='biochem'), 'mystery_type', '没见过的题型', 9);"
bash "$ROOT_DIR/../scripts/ci/ensure-columns.sh" --local >/tmp/n5-ensure.log 2>&1
check "填不出来的列让脚本退出码非 0" "$?" "1"
# 两个列各打一次，所以只断言"出现过"，不断言出现几次
check "并且把是哪一行打出来" "$([ "$(grep -c mystery_type /tmp/n5-ensure.log)" -ge 1 ] && echo 打了 || echo 没打)" "打了"
exec_sql "DELETE FROM subject_question_types WHERE type_code='mystery_type';"
bash "$ROOT_DIR/../scripts/ci/ensure-columns.sh" --local >/dev/null 2>&1
check "清掉之后又能通过" "$?" "0"

echo "== 启动服务 =="
DEV_LOG=/tmp/n5-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }
echo "  服务已就绪"

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-n5' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin12345"}' | jq -r '.token')
[ "$ADMIN" != "null" ] && [ -n "$ADMIN" ] || { echo "管理员登录失败"; exit 1; }
BIO=$(one "SELECT subject_id FROM subjects WHERE code='biochem';")

echo
echo "== 后台能改这两个维度，且改错了当场拒绝 =="
adm -o /tmp/n5-pack.json "$BASE/admin/subjects/$BIO/pack"
check "策略注册表暴露给界面" \
  "$(jq -r '[.availableStrategies[] | select(.implemented) | .code] | sort | join(",")' /tmp/n5-pack.json)" \
  "AI_DIMENSION,AI_LEVEL_BANDED,AI_SCORE_POINTS,ENUM,EXACT,MANUAL,NUMERIC,SET"
check "没实现的策略也列出来，但标了出来" \
  "$(jq -r '[.availableStrategies[] | select(.implemented | not) | .code] | join(",")' /tmp/n5-pack.json)" "SEQUENCE"
check "作答形态清单暴露给界面" "$(jq -r '.availableShapes | length' /tmp/n5-pack.json)" "7"
check "题型带回判分策略" \
  "$(jq -r '.questionTypes[] | select(.type_code=="term_explain") | .grading_strategy' /tmp/n5-pack.json)" "AI_SCORE_POINTS"

TYPES=$(jq -c '[.questionTypes[] | {typeCode: .type_code, name, isObjective: (.is_objective == 1),
  inPractice: (.in_practice == 1), needsAi: (.needs_ai == 1), inputWidget: .input_widget,
  aiReviewOnMiss: (.ai_review_on_miss == 1), normalizers: (.normalizers | fromjson),
  answerShape: .answer_shape, gradingStrategy: .grading_strategy}]' /tmp/n5-pack.json)
CODE=$(admj -o /dev/null -w '%{http_code}' -X PUT "$BASE/admin/subjects/$BIO/pack/types" \
  -d "$(jq -n --argjson t "$TYPES" '{questionTypes:$t}')")
check "原样存回去是 200" "$CODE" "200"
check "两个维度没在往返中丢掉" "$(one "SELECT COUNT(*) FROM subject_question_types
  WHERE subject_id=$BIO AND (grading_strategy IS NULL OR answer_shape IS NULL);")" "0"

bad_types() {  # $1 = jq 表达式
  admj -o /tmp/n5-bad.json -w '%{http_code}' -X PUT "$BASE/admin/subjects/$BIO/pack/types" \
    -d "$(jq -n --argjson t "$(echo "$TYPES" | jq -c "$1")" '{questionTypes:$t}')"
}
check "认不出的判分策略被拒" "$(bad_types '[.[0] | .gradingStrategy = "NO_SUCH"]')" "400"
check "拒绝时说清楚有哪些可选" "$(jq -r '.problems | join(" ")' /tmp/n5-bad.json | grep -c 'AI_SCORE_POINTS')" "1"
check "没实现的策略也被拒" "$(bad_types '[.[0] | .gradingStrategy = "SEQUENCE"]')" "400"
check "认不出的作答形态被拒" "$(bad_types '[.[0] | .answerShape = "SOMETHING"]')" "400"
# 勾了"需要 AI"却选规则策略：交卷时的"待批改"计数会和实际判分对不上，而界面看不出异常
check "needs_ai 与策略打架被拒" "$(bad_types '[.[0] | .gradingStrategy = "EXACT" | .needsAi = true]')" "400"
check "反过来也被拒" "$(bad_types '[.[0] | .gradingStrategy = "AI_SCORE_POINTS" | .needsAi = false]')" "400"
check "被拒之后库里的题型没被动过" "$(one "SELECT COUNT(*) FROM subject_question_types WHERE subject_id=$BIO;")" \
  "$(jq -r 'length' <<<"$TYPES")"

echo
echo "== 评价标准：第三种 rubric 与答对阈值 =="
RUBRIC=$(jq -c '.currentRubric.payload | fromjson' /tmp/n5-pack.json)
put_rubric() {
  admj -o /tmp/n5-rub.json -w '%{http_code}' -X PUT "$BASE/admin/subjects/$BIO/pack/rubric" \
    -d "$(jq -n --argjson p "$(echo "$RUBRIC" | jq -c "$1")" '{payload:$p}')"
}
BANDS='{"type":"LEVEL_BANDED","totalScore":20,"requireReason":true,"bands":[
  {"level":2,"name":"一类","range":[11,20],"desc":"论点鲜明"},
  {"level":1,"name":"二类","range":[0,10],"desc":"论据单薄"}]}'
check "分档评分是合法的评价标准" "$(put_rubric ".essay = $BANDS")" "200"
check "档次区间重叠被拒" \
  "$(put_rubric ".essay = ($BANDS | .bands[1].range = [0,15])")" "400"
check "档次没写描述被拒（AI 没有落档依据）" \
  "$(put_rubric ".essay = ($BANDS | .bands[0].desc = \"\")")" "400"
check "答对阈值缺失被拒" "$(put_rubric 'del(.mastery.correctThreshold)')" "400"
check "答对阈值超出 0～1 被拒" "$(put_rubric '.mastery.correctThreshold = 2')" "400"
check "开放采分点权重上限超出 0～1 被拒" "$(put_rubric '.essay.openWeightCap = 1.5')" "400"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
