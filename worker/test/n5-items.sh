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
one()  { sql "$1" | jq -r '.[0].results[0] // {} | to_entries[0].value // empty'; }
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
npx wrangler d1 execute "$D1_NAME" --local --file=seed/english-000-knowledge-points.sql >/dev/null 2>&1
# 四套真题：13000 的组卷模板要 10 题一篇的「段落大意与句子补全」，
# 2015-04 那篇被扣下一道存疑题只剩 9 道，凑不满。少导的话组卷会直接失败，
# 而失败信息看着像"模板配错了"。
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "找不到 $EXAM 的种子，先跑 node scripts/build-seed-sql.mjs"; exit 1; }
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

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

echo
echo "== 旧库模拟：补列必须排在迁移之前 =="
# 这一段复现的是部署 #48：迁移里只要有一条语句**提到**新列，在旧库上就整条失败，
# 哪怕那条语句带着门闩、一行都不会插——SQLite 准备语句时就校验列名，不看 WHERE。
# 本地库每次都是新建的，天生带着这两列，所以不把列删掉就永远测不到这件事。
npx wrangler d1 execute "$D1_NAME" --local --command \
  "ALTER TABLE subject_question_types DROP COLUMN answer_shape;" >/dev/null 2>&1
npx wrangler d1 execute "$D1_NAME" --local --command \
  "ALTER TABLE subject_question_types DROP COLUMN grading_strategy;" >/dev/null 2>&1
check "旧库模拟成功（两列都没了）" "$(cols subject_question_types | grep -cw answer_shape)" "0"

# ① 反面：先迁移后补列，0009 当场红。这一条是"顺序错了会怎样"的证据，
#    没有它，下面那条"顺序对了能过"说明不了顺序有没有用。
npx wrangler d1 execute "$D1_NAME" --local --file=migrations/0009_subject_pack.sql >/tmp/n5-mig9.log 2>&1
check "旧库上直接跑迁移会失败" "$?" "1"
check "报错点名是哪一列" "$(grep -c 'no column named answer_shape' /tmp/n5-mig9.log)" "1"

# ② 正面：按流水线的顺序，先补列再迁移
bash "$ROOT_DIR/../scripts/ci/ensure-columns.sh" --local >/tmp/n5-ensure2.log 2>&1
check "补列步骤通过" "$?" "0"
check "两列都补回来了" "$(cols subject_question_types | grep -cw grading_strategy)" "1"
check "旧行的策略也回填了" "$(one 'SELECT COUNT(*) FROM subject_question_types WHERE grading_strategy IS NULL;')" "0"
MIGOK=1
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || MIGOK=0
done
check "补完列之后整套迁移跑得过" "$MIGOK" "1"

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
ENG=$(one "SELECT subject_id FROM subjects WHERE code='english';")
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"N501","password":"student12345","subjects":["english"]}'
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"N501","password":"student12345"}' | jq -r '.token')
[ "$STU" != "null" ] && [ -n "$STU" ] || { echo "学员登录失败"; exit 1; }
stu()  { curl -s -H "Authorization: Bearer $STU" "$@"; }
stuj() { curl -s -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' "$@"; }
gen_exam() {
  stuj -X POST "$BASE/exams/generate" -d '{"courseCode":"13000","difficulty":"随机"}'
}

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
echo "== 组卷筛选器：按题型筛与按篇章类型筛必须是一回事 =="
# 新的 candidateSections 用 q.section_type 筛，旧的用 s.type。两者在数据上一致
# 才谈得上"行为没变"；不一致时组卷会悄悄换一批篇章，没有任何地方会报错。
check "没有题目的 section_type 与所属篇章的 type 对不上" \
  "$(one 'SELECT COUNT(*) FROM questions q JOIN sections s ON s.section_id=q.section_id WHERE q.section_type <> s.type;')" "0"

echo
echo "== 分值归属：卷面总分从 attempt_questions 现加（B19）=="
G1=$(gen_exam); A1=$(echo "$G1" | jq -r '.attemptId')
[ "$A1" != "null" ] && [ -n "$A1" ] || { echo "组卷失败：$(echo "$G1" | head -c 200)"; exit 1; }
# 期望值从库里现加，不写死 100——改了模板这条不该跟着红
check "接口给的总分等于逐题分值之和" "$(echo "$G1" | jq -r '.totalScore')" \
  "$(one "SELECT CAST(SUM(score_per_question) AS INT) FROM attempt_questions WHERE attempt_id='$A1';")"
G2=$(gen_exam); A2=$(echo "$G2" | jq -r '.attemptId')
check "同一模板再组一次，总分不变" "$(echo "$G2" | jq -r '.totalScore')" "$(echo "$G1" | jq -r '.totalScore')"
check "题数也不变" "$(echo "$G2" | jq -r '.questionCount')" "$(echo "$G1" | jq -r '.questionCount')"

# B19 的核心：总分不随题目空数浮动。给卷子里的一道填空题挂三个空，再组一份卷。
QF=$(one "SELECT aq.question_id FROM attempt_questions aq JOIN questions q ON q.question_id=aq.question_id
          WHERE aq.attempt_id='$A1' AND q.question_type='fill_text' ORDER BY aq.ord LIMIT 1;")
check "卷子里确实有填空题（否则下面几条是空断言）" "$([ -n "$QF" ] && echo 有 || echo 无)" "有"
for i in 1 2 3; do
  exec_sql "INSERT OR REPLACE INTO question_items
    (question_id, item_ord, subject_id, item_kind, answer, weight)
    VALUES ('$QF', $i, $ENG, 'BLANK', '空${i}答案', 1);"
done
G3=$(gen_exam)
check "题目从 1 个空变成 3 个空之后，卷面总分仍然不变" \
  "$(echo "$G3" | jq -r '.totalScore')" "$(echo "$G1" | jq -r '.totalScore')"

echo
echo "== 多单元题端到端：一空一框、逐空判、部分分开关 =="
# 在 A2 这份卷上作答（它的题目与 A1 未必相同，所以单独取一道带空的题）
QA=$(one "SELECT question_id FROM attempt_questions WHERE attempt_id='$A2' AND question_id='$QF';")
if [ -z "$QA" ]; then
  # A2 没抽到那道题就临时把空挂到 A2 的一道填空题上
  QA=$(one "SELECT aq.question_id FROM attempt_questions aq JOIN questions q ON q.question_id=aq.question_id
            WHERE aq.attempt_id='$A2' AND q.question_type='fill_text' ORDER BY aq.ord LIMIT 1;")
  for i in 1 2 3; do
    exec_sql "INSERT OR REPLACE INTO question_items
      (question_id, item_ord, subject_id, item_kind, answer, weight)
      VALUES ('$QA', $i, $ENG, 'BLANK', '空${i}答案', 1);"
  done
fi
check "取到一道挂了空的题" "$(one "SELECT COUNT(*) FROM question_items WHERE question_id='$QA';")" "3"
QSCORE=$(one "SELECT score_per_question FROM attempt_questions WHERE attempt_id='$A2' AND question_id='$QA';")
check "取回作答页时带上了这道题的三个空" \
  "$(stu "$BASE/attempts/$A2" | jq -r --arg q "$QA" '[.sections[].questions[] | select(.questionId==$q)][0].items | length')" "3"
# 三个空答对两个
stuj -o /dev/null -X PUT "$BASE/attempts/$A2/answers" \
  -d "$(jq -n --arg q "$QA" '{questionId:$q,answer:"{\"1\":\"空1答案\",\"2\":\"空2答案\",\"3\":\"写错了\"}"}')"
stu -o /dev/null -X POST "$BASE/attempts/$A2/submit"
R2=$(stu "$BASE/attempts/$A2/report")
QR2=$(echo "$R2" | jq -c --arg q "$QA" '[.sections[].questions[] | select(.questionId==$q)][0]')
# 英语不给部分分（rubric.grading.partialCredit=false），三个空对两个＝整题 0 分
check "不给部分分的学科：三空对二判 0 分" "$(echo "$QR2" | jq -r '.score')" "0"
check "得分率也记 0" "$(echo "$QR2" | jq -r '.scoreRate')" "0"
check "逐空结果照样留着（学生要看到错在哪一空）" "$(echo "$QR2" | jq -r '[.itemResults[].items[]] | length')" "3"
check "第 3 空记未命中" "$(echo "$QR2" | jq -r '[.itemResults[].items[] | select(.ord==3)][0].hit')" "0"
check "第 1 空记命中" "$(echo "$QR2" | jq -r '[.itemResults[].items[] | select(.ord==1)][0].hit')" "1"
check "逐空结果落了库" "$(one "SELECT COUNT(*) FROM answer_records
  WHERE attempt_id='$A2' AND question_id='$QA' AND item_results IS NOT NULL;")" "1"

# 把英语改成给部分分，同样的作答应当拿 2/3——这一对才证明开关真的在起作用
RUB=$(adm "$BASE/admin/subjects/$ENG/pack" | jq -c '.currentRubric.payload | fromjson')
admj -o /dev/null -X PUT "$BASE/admin/subjects/$ENG/pack/rubric" \
  -d "$(jq -n --argjson p "$(echo "$RUB" | jq -c '.grading.partialCredit = true')" '{payload:$p}')"
A3=$(gen_exam | jq -r '.attemptId')
QB=$(one "SELECT aq.question_id FROM attempt_questions aq JOIN question_items i ON i.question_id=aq.question_id
          WHERE aq.attempt_id='$A3' LIMIT 1;")
if [ -z "$QB" ]; then
  QB=$(one "SELECT aq.question_id FROM attempt_questions aq JOIN questions q ON q.question_id=aq.question_id
            WHERE aq.attempt_id='$A3' AND q.question_type='fill_text' ORDER BY aq.ord LIMIT 1;")
  for i in 1 2 3; do
    exec_sql "INSERT OR REPLACE INTO question_items
      (question_id, item_ord, subject_id, item_kind, answer, weight)
      VALUES ('$QB', $i, $ENG, 'BLANK', '空${i}答案', 1);"
  done
fi
BSCORE=$(one "SELECT score_per_question FROM attempt_questions WHERE attempt_id='$A3' AND question_id='$QB';")
stuj -o /dev/null -X PUT "$BASE/attempts/$A3/answers" \
  -d "$(jq -n --arg q "$QB" '{questionId:$q,answer:"{\"1\":\"空1答案\",\"2\":\"空2答案\",\"3\":\"写错了\"}"}')"
stu -o /dev/null -X POST "$BASE/attempts/$A3/submit"
QR3=$(stu "$BASE/attempts/$A3/report" | jq -c --arg q "$QB" '[.sections[].questions[] | select(.questionId==$q)][0]')
# 期望值从该题在本卷的分值现算：得分率 2/3 × 分值，保留两位
# 期望值从该题在本卷的分值现算，并且两边都换算成整数比，免得 1 与 1.0 判不相等
WANT=$(python3 -c "print(round(round(2/3, 6) * $BSCORE * 1000))")
check "改成给部分分之后，同一份作答拿到 2/3 的分" \
  "$(echo "$QR3" | jq -r '(.score * 1000) | round')" "$WANT"
check "得分率是 2/3" "$(echo "$QR3" | jq -r '.scoreRate')" "0.666667"
# 得分率 0.667 达不到默认阈值 1.0，按 B13 仍记"答错"
check "部分得分仍按答错记（阈值 1.0）" "$(echo "$QR3" | jq -r '.isCorrect')" "0"
admj -o /dev/null -X PUT "$BASE/admin/subjects/$ENG/pack/rubric" \
  -d "$(jq -n --argjson p "$RUB" '{payload:$p}')"

echo
echo "== 结构化组卷模板 =="
TPL_N=$(one "SELECT COUNT(*) FROM exam_template_items WHERE course_code='13000';")
# ① 认不出的筛选条件要当场拒绝，不能悄悄当成"没有条件"去全库抽题
exec_sql "INSERT INTO exam_template_items (course_code, ord, label, filter, question_count, score_per_question, pick_unit)
  VALUES ('13000', 90, '瞎写的条件', '{\"chapters\":[1]}', 1, 1, 'QUESTION');"
BAD=$(stuj -o /tmp/n5-badfilter.json -w '%{http_code}' -X POST "$BASE/exams/generate" -d '{"courseCode":"13000"}')
check "认不出的筛选条件让组卷失败" "$BAD" "422"
check "错误码点名是筛选条件的问题" "$(jq -r '.error' /tmp/n5-badfilter.json)" "unsupported_filter"
check "报错里说清楚是哪个键" "$(jq -r '.message' /tmp/n5-badfilter.json | grep -c chapters)" "1"
exec_sql "DELETE FROM exam_template_items WHERE course_code='13000' AND ord=90;"
# ② FROM_QUESTION 还没实现，要报错而不是悄悄按模板分算
exec_sql "INSERT INTO exam_template_items (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
  VALUES ('13000', 91, '题目自带分值', '{}', 1, 'FROM_QUESTION', 1, 'QUESTION');"
BAD2=$(stuj -o /tmp/n5-badmode.json -w '%{http_code}' -X POST "$BASE/exams/generate" -d '{"courseCode":"13000"}')
check "FROM_QUESTION 让组卷失败" "$BAD2" "422"
check "错误码点名是配分方式" "$(jq -r '.error' /tmp/n5-badmode.json)" "score_mode_not_implemented"
exec_sql "DELETE FROM exam_template_items WHERE course_code='13000' AND ord=91;"
# ③ 单题抽。英语的单选全挂在带原文的篇章下，而单题抽本来就该跳过这类题
#    （§6.4.9 的 requires_context），所以拿真实题库测不出来——这里自己造两篇：
#    一篇没有原文（3 道单选 + 1 道填空），一篇有原文（2 道单选），两篇同一种篇章类型。
#    只从没有原文的那篇里抽、且只抽单选，两条才都测得到。
EX=$(one "SELECT exam_id FROM exams WHERE course_code='13000' AND status='已发布' LIMIT 1;")
exec_sql "INSERT INTO sections (section_id, exam_id, type, ord, passage_title, passage_text)
  VALUES ('n5-sec-free', '$EX', 'N5单题抽', 90, '无原文', NULL),
         ('n5-sec-ctx',  '$EX', 'N5单题抽', 91, '有原文', '这是一段必须连着读的原文');"
for i in 1 2 3; do
  exec_sql "INSERT INTO questions (question_id, section_id, exam_id, course_code, section_type, ord,
    question_type, stem, options, answer, status, answer_state, answer_source, subject_id)
    VALUES ('n5-free-$i', 'n5-sec-free', '$EX', '13000', 'N5单题抽', $i, 'single_choice',
            '构造题 $i', '[\"A. 甲\",\"B. 乙\"]', 'A', '已发布', '已确认', 'MANUAL', $ENG);"
done
exec_sql "INSERT INTO questions (question_id, section_id, exam_id, course_code, section_type, ord,
  question_type, stem, answer, status, answer_state, answer_source, subject_id)
  VALUES ('n5-free-fill', 'n5-sec-free', '$EX', '13000', 'N5单题抽', 4, 'fill_text',
          '构造填空', 'x', '已发布', '已确认', 'MANUAL', $ENG);"
for i in 1 2; do
  exec_sql "INSERT INTO questions (question_id, section_id, exam_id, course_code, section_type, ord,
    question_type, stem, options, answer, status, answer_state, answer_source, subject_id)
    VALUES ('n5-ctx-$i', 'n5-sec-ctx', '$EX', '13000', 'N5单题抽', $i, 'single_choice',
            '离开原文读不懂的题 $i', '[\"A. 甲\",\"B. 乙\"]', 'A', '已发布', '已确认', 'MANUAL', $ENG);"
done
check "构造了 5 道单选，其中 2 道依赖原文" "$(one "
  SELECT COUNT(*) FROM questions q JOIN sections s ON s.section_id=q.section_id
   WHERE q.section_type='N5单题抽' AND q.question_type='single_choice'
     AND s.passage_text IS NOT NULL AND s.passage_text <> '';")" "2"
exec_sql "INSERT INTO exam_template_items (course_code, ord, label, filter, question_count, score_per_question, pick_unit)
  VALUES ('13000', 92, '单题抽的选择题',
          '{\"questionTypes\":[\"single_choice\"],\"sectionTypes\":[\"N5单题抽\"]}', 3, 2, 'QUESTION');"
G4=$(gen_exam); A4=$(echo "$G4" | jq -r '.attemptId')
check "单题抽的部分出现在卷面上" "$(echo "$G4" | jq -r '[.sections[] | select(.sectionOrd==92)] | length')" "1"
check "这一部分正好 3 题" "$(echo "$G4" | jq -r '[.sections[] | select(.sectionOrd==92)][0].questionCount')" "3"
check "总分 = 原来 + 3×2" "$(echo "$G4" | jq -r '.totalScore')" \
  "$(python3 -c "print(int($(echo "$G1" | jq -r '.totalScore')) + 6)")"
# 单题抽不该抽到依赖原文的题（§6.4.9 requires_context 落地前按"所属篇章有没有原文"判断）
check "单题抽出来的题都不依赖原文" "$(one "
  SELECT COUNT(*) FROM attempt_questions aq JOIN sections s ON s.section_id=aq.section_id
   WHERE aq.attempt_id='$A4' AND aq.section_ord=92
     AND s.passage_text IS NOT NULL AND s.passage_text <> '';")" "0"
check "抽出来的确实都是单选" "$(one "
  SELECT COUNT(*) FROM attempt_questions aq JOIN questions q ON q.question_id=aq.question_id
   WHERE aq.attempt_id='$A4' AND aq.section_ord=92 AND q.question_type <> 'single_choice';")" "0"
check "抽出来的三道正好是那三道无原文的单选" "$(one "
  SELECT COUNT(*) FROM attempt_questions WHERE attempt_id='$A4' AND section_ord=92
     AND question_id IN ('n5-free-1','n5-free-2','n5-free-3');")" "3"
# 上面那条在"两条规则都失效"时仍有一成概率蒙对（候选题都没挂考点，多选几道是随机的）。
# 下面两条把它钉死：候选池按规则算只有 3 道，多要一道就该组不出卷。
#   要 4 道 → 题型筛选若失效（构造填空也算进来）就会有 4 道候选，于是能组出卷
#   要 5 道 → 原文规则若失效（两道依赖原文的也算进来）就会有 5 道候选，于是能组出卷
exec_sql "UPDATE exam_template_items SET question_count = 4 WHERE course_code='13000' AND ord=92;"
check "要 4 道时组不出卷（题型筛选把构造填空挡在外面）" \
  "$(stuj -o /dev/null -w '%{http_code}' -X POST "$BASE/exams/generate" -d '{"courseCode":"13000"}')" "422"
exec_sql "UPDATE exam_template_items SET question_count = 5 WHERE course_code='13000' AND ord=92;"
check "要 5 道时组不出卷（依赖原文的两道不参与单题抽）" \
  "$(stuj -o /dev/null -w '%{http_code}' -X POST "$BASE/exams/generate" -d '{"courseCode":"13000"}')" "422"
exec_sql "DELETE FROM exam_template_items WHERE course_code='13000' AND ord=92;"
exec_sql "DELETE FROM attempt_questions WHERE question_id LIKE 'n5-free-%' OR question_id LIKE 'n5-ctx-%';"
exec_sql "DELETE FROM questions WHERE section_id IN ('n5-sec-free','n5-sec-ctx');"
exec_sql "DELETE FROM sections WHERE section_id IN ('n5-sec-free','n5-sec-ctx');"
check "模板恢复原样" "$(one "SELECT COUNT(*) FROM exam_template_items WHERE course_code='13000';")" "$TPL_N"

echo
# 服务中途死掉的话，上面会塌出一串看不懂的断言失败（期望 422 实际 000 之类）。
# wrangler dev 自己崩过一次（它的日志里是一条空的 ProxyController 错误），
# 所以这里显式断一条：跑完之后服务还活着。塌掉时至少能一眼看出是服务没了，
# 而不是去逐条查那些断言。
check "跑完之后服务还活着" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/health")" "200"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
