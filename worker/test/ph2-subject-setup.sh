#!/usr/bin/env bash
# 改进阶段 2 第一期·后台自助开学科（2026-11-08）：建课复制能力包、题库文件导入、组卷模板、上线清单、
# 一键发布、学科开关、改课程、每月花费上限、审计。需求见 docs/改进阶段2-PRD.md 第 5 节。
#
# 期望值一律从题库文件 / 组卷模板文件 / 库里现算，不拿接口自己的数去对接口。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8771          # 端口表见 CLAUDE.md
BASE="http://127.0.0.1:$PORT/api"
PE_DIR="$ROOT_DIR/../data/subjects/pubeng"
TEST2="$PE_DIR/groups/pubeng-s4-test2.json"
TPL_JSON="$PE_DIR/exam-template.json"
WORK=$(mktemp -d)
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc";
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill -- "-$SERVER_PID" 2>/dev/null
  rm -rf "$ROOT_DIR/.wrangler" "$WORK"
  rm -f .dev.vars
}
trap cleanup EXIT

source "$ROOT_DIR/test/lib/d1.sh"
[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }

echo "== 准备本地数据库：迁移 + 英语、生化、公共英语三门的题库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-ph2setup
SETUP_TOKEN=test-setup-ph2setup
ENCRYPTION_KEY=test-encryption-key-ph2setup
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "迁移 $m 失败"; exit 1; }
done
for s in biochem pubeng; do
  SEED_SUBJECT_DIR="$ROOT_DIR/../data/subjects/$s" node ../scripts/build-seed-sql.mjs "$WORK/seed-$s" > "$WORK/seed-$s.log" 2>&1 \
    || { echo "$s 种子生成失败："; cat "$WORK/seed-$s.log"; exit 1; }
  for f in "$WORK/seed-$s"/*.sql; do
    npx wrangler d1 execute "$D1_NAME" --local --file="$f" >/dev/null 2>&1 || { echo "导入 $f 失败"; exit 1; }
  done
done

echo
echo "== 迁移 0019：参数和门槛只写一次 =="
check "每人每天练习批改上限默认 100" "$(one "SELECT value FROM system_settings WHERE key = 'limit.practice_ai_per_day';")" "100"
check "每个学科当前的评价标准都补上了 pointCorrectThreshold" \
  "$(one "SELECT COUNT(*) FROM subject_rubrics WHERE is_current = 1 AND json_extract(payload, '\$.mastery.pointCorrectThreshold') IS NULL;")" "0"
check "补上的值是 0.6（公共英语）" \
  "$(one "SELECT json_extract(payload, '\$.mastery.pointCorrectThreshold') FROM subject_rubrics r JOIN subjects s ON s.subject_id = r.subject_id WHERE s.code = 'pubeng' AND r.is_current = 1;")" "0.6"
exec_sql "UPDATE system_settings SET value = '7' WHERE key = 'limit.practice_ai_per_day';
          UPDATE subject_rubrics SET payload = json_set(payload, '\$.mastery.pointCorrectThreshold', 0.8)
           WHERE is_current = 1 AND subject_id = (SELECT subject_id FROM subjects WHERE code = 'biochem');"
npx wrangler d1 execute "$D1_NAME" --local --file=migrations/0019_phase2.sql >/dev/null 2>&1
check "0019 重跑：管理员改过的上限没被冲回 100" "$(one "SELECT value FROM system_settings WHERE key = 'limit.practice_ai_per_day';")" "7"
check "0019 重跑：改过的门槛没被冲回 0.6" \
  "$(one "SELECT json_extract(payload, '\$.mastery.pointCorrectThreshold') FROM subject_rubrics r JOIN subjects s ON s.subject_id = r.subject_id WHERE s.code = 'biochem' AND r.is_current = 1;")" "0.8"
exec_sql "UPDATE system_settings SET value = '100' WHERE key = 'limit.practice_ai_per_day';"

echo
echo "== 启动服务 =="
DEV_LOG=/tmp/ph2-subject-setup-dev.log
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
ready=0
for i in $(seq 1 150); do curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1; done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-ph2setup' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
STU_PASS=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"username":"PH2S01","subjects":["pubeng"]}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$STU_PASS" '{username:"PH2S01",password:$p}')" | jq -r '.token')
[ -n "$ADMIN" ] && [ "$ADMIN" != null ] && [ -n "$STU" ] && [ "$STU" != null ] || { echo "取令牌失败"; exit 1; }

A() { curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$@"; }
code() { curl -s -o "$WORK/last.json" -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
PE_ID=$(one "SELECT subject_id FROM subjects WHERE code = 'pubeng';")

echo
echo "== 每个新接口：学员 403、不存在的学科 404 =="
for spec in "GET /admin/subjects/suggest-code" "GET /admin/subjects/$PE_ID/template" "PUT /admin/subjects/$PE_ID/template" \
            "POST /admin/subjects/$PE_ID/template/draft" "GET /admin/subjects/$PE_ID/checklist" "GET /admin/checklists" \
            "POST /admin/subjects/$PE_ID/publish-all" "PUT /admin/subjects/$PE_ID/settings/auto-grant" \
            "PUT /admin/subjects/$PE_ID/settings/practice-ai" "PATCH /admin/courses/pubeng-main" \
            "GET /admin/ai/spend" "GET /admin/ai/budget" "PUT /admin/ai/budget"; do
  set -- $spec
  check "学员令牌调 $1 $2 → 403" "$(code -X "$1" "$BASE$2" -H "Authorization: Bearer $STU" -d '{}')" "403"
done
for spec in "GET /admin/subjects/99999/template" "PUT /admin/subjects/99999/template" "POST /admin/subjects/99999/template/draft" \
            "GET /admin/subjects/99999/checklist" "POST /admin/subjects/99999/publish-all" \
            "PUT /admin/subjects/99999/settings/auto-grant" "PATCH /admin/courses/no-such-course"; do
  set -- $spec
  check "不存在的学科 / 课程：$1 $2 → 404" "$(code -X "$1" "$BASE$2" -H "Authorization: Bearer $ADMIN" -d '{"enabled":true,"version":0}')" "404"
done

echo
echo "== A 开一门新课：参照公共英语 =="
SUG=$(A "$BASE/admin/subjects/suggest-code" | jq -r '.code')
check "默认学科码是 s + 两位序号，而且没被占用" \
  "$([[ "$SUG" =~ ^s[0-9]{2}$ ]] && [ "$(one "SELECT COUNT(*) FROM subjects WHERE code = '$SUG';")" = 0 ] && echo 是 || echo "否（$SUG）")" "是"
check "参照公共英语建「公共英语副本」→ 201" \
  "$(code -X POST "$BASE/admin/subjects" -H "Authorization: Bearer $ADMIN" \
     -d '{"name":"公共英语副本","code":"pecopy","copyFrom":"pubeng","totalScore":100,"timeLimitMinutes":90}')" "201"
cp "$WORK/last.json" "$WORK/pecopy.json"
CP_ID=$(jq -r '.subject.subjectId' "$WORK/pecopy.json")
check "课程码是 学科码-main，时长按填的 90 分钟" \
  "$(one "SELECT course_code || '|' || time_limit_minutes || '|' || CAST(total_score AS INTEGER) FROM courses WHERE subject_id = $CP_ID;")" "pecopy-main|90|100"
check "题型一个不少：和公共英语声明的一样（类型码、判分策略、控件）" \
  "$(one "SELECT group_concat(type_code || ':' || grading_strategy || ':' || input_widget, ',') FROM (SELECT * FROM subject_question_types WHERE subject_id = $CP_ID ORDER BY type_code);")" \
  "$(one "SELECT group_concat(type_code || ':' || grading_strategy || ':' || input_widget, ',') FROM (SELECT * FROM subject_question_types WHERE subject_id = $PE_ID ORDER BY type_code);")"
check "评价标准复制成第 1 版、带着 pointCorrectThreshold" \
  "$(one "SELECT version || '|' || json_extract(payload, '\$.mastery.pointCorrectThreshold') FROM subject_rubrics WHERE subject_id = $CP_ID AND is_current = 1;")" "1|0.6"
N_PE_PROMPTS=$(one "SELECT COUNT(*) FROM subject_ai_prompts WHERE subject_id = $PE_ID;")
check "公共英语自己的 $N_PE_PROMPTS 条提示词都复制过来了" "$(one "SELECT COUNT(*) FROM subject_ai_prompts WHERE subject_id = $CP_ID;")" "$N_PE_PROMPTS"
# 新名字里含旧名字，所以先把新名字去掉再找旧名字
check "提示词里的学科名换成了新学科名（去掉新名之后不再出现旧名）" \
  "$(one "SELECT COUNT(*) FROM subject_ai_prompts WHERE subject_id = $CP_ID AND instr(replace(system_prompt || user_template, '公共英语副本', ''), '公共英语') > 0;")" "0"
check "返回里点名了复制来的提示词，请管理员看一眼" "$(jq -r '.copiedPrompts | length' "$WORK/pecopy.json")" "$N_PE_PROMPTS"
check "新学科的导入管线是题库文件（json-direct）、内容组类型是 TEXTBOOK_CHAPTER" \
  "$(one "SELECT ingest_pipeline || '|' || content_group_kind FROM subjects WHERE subject_id = $CP_ID;")" "json-direct|TEXTBOOK_CHAPTER"
check "能力包读得出（GET pack 200）" "$(code "$BASE/admin/subjects/$CP_ID/pack" -H "Authorization: Bearer $ADMIN")" "200"
check "建学科写了一笔审计" "$(one "SELECT COUNT(*) FROM admin_audit WHERE action = 'subject.create' AND target = 'pecopy';")" "1"

echo
echo "== A 不参照：通用题型 =="
check "不参照建「通用课」→ 201" \
  "$(code -X POST "$BASE/admin/subjects" -H "Authorization: Bearer $ADMIN" -d '{"name":"通用课","code":"gen01"}')" "201"
GEN_ID=$(jq -r '.subject.subjectId' "$WORK/last.json")
check "三种通用题型" "$(one "SELECT group_concat(type_code, ',') FROM (SELECT type_code FROM subject_question_types WHERE subject_id = $GEN_ID ORDER BY type_code);")" \
  "fill_text,short_answer,single_choice"
check "通用题型照抄生化的同码行（判分策略、归一化器一致）" \
  "$(one "SELECT group_concat(type_code || grading_strategy || normalizers, ',') FROM (SELECT * FROM subject_question_types WHERE subject_id = $GEN_ID ORDER BY type_code);")" \
  "$(one "SELECT group_concat(type_code || grading_strategy || normalizers, ',') FROM (SELECT * FROM subject_question_types WHERE subject_id = (SELECT subject_id FROM subjects WHERE code = 'biochem') AND type_code IN ('fill_text','short_answer','single_choice') ORDER BY type_code);")"
check "简答的批改提示词是按采分点批的那份（不是全局默认的作文版）" \
  "$(one "SELECT (instr(user_template, '{{pointLines}}') > 0) || '/' || (instr(user_template, '学生作文') > 0) FROM subject_ai_prompts WHERE subject_id = $GEN_ID AND feature = 'essay_grade';")" "1/0"
check "默认满分 100、时长 120" "$(one "SELECT CAST(total_score AS INTEGER) || '|' || time_limit_minutes FROM courses WHERE subject_id = $GEN_ID;")" "100|120"
check "通用课的能力包也读得出" "$(code "$BASE/admin/subjects/$GEN_ID/pack" -H "Authorization: Bearer $ADMIN")" "200"

echo
echo "== A 拒绝的情况 =="
check "学科名重复 → 409" "$(code -X POST "$BASE/admin/subjects" -H "Authorization: Bearer $ADMIN" -d '{"name":"通用课","code":"gen02"}')" "409"
check "满分超出 1–1000 → 400" "$(code -X POST "$BASE/admin/subjects" -H "Authorization: Bearer $ADMIN" -d '{"name":"x课","code":"gen03","totalScore":0}')" "400"
check "参照的学科不存在 → 404" "$(code -X POST "$BASE/admin/subjects" -H "Authorization: Bearer $ADMIN" -d '{"name":"y课","code":"gen04","copyFrom":"nosuch"}')" "404"
# 参照一门能力包坏了的学科：内存里先验，一行都不写
exec_sql "INSERT INTO subjects (code, name) VALUES ('broken', '坏学科');
          INSERT INTO subject_question_types (subject_id, type_code, name, is_objective, in_practice, needs_ai, input_widget, normalizers, sort_order, answer_shape, grading_strategy)
          VALUES ((SELECT subject_id FROM subjects WHERE code = 'broken'), 'single_choice', '单选', 1, 1, 0, 'choice', '[]', 1, 'CHOICE_ONE', 'NO_SUCH_STRATEGY');
          INSERT INTO subject_rubrics (subject_id, version, payload, is_current)
          SELECT (SELECT subject_id FROM subjects WHERE code = 'broken'), 1, payload, 1 FROM subject_rubrics WHERE subject_id = $GEN_ID;"
check "参照能力包坏了的学科 → 422 subject_pack_broken" \
  "$(code -X POST "$BASE/admin/subjects" -H "Authorization: Bearer $ADMIN" -d '{"name":"坏课副本","code":"brkcopy","copyFrom":"broken"}')/$(jq -r '.error' "$WORK/last.json")" \
  "422/subject_pack_broken"
check "422 时库里没有留下新学科、课程的任何一行" \
  "$(one "SELECT (SELECT COUNT(*) FROM subjects WHERE code = 'brkcopy') + (SELECT COUNT(*) FROM courses WHERE course_code = 'brkcopy-main');")" "0"

echo
echo "== I1 题库文件导入 =="
N_FILE=$(jq '[.sections[].questions[]] | length' "$TEST2")
N_ITEMS=$(jq '[.sections[].questions[].items // [] | length] | add' "$TEST2")
# 已确认 = 题自己的 answerState，没有就用组级的（和种子生成器同一个口径）
N_CONF=$(jq '(.answerState) as $g | [.sections[].questions[] | (.answerState // $g)] | map(select(. == "已确认")) | length' "$TEST2")
up() { curl -s -o "$WORK/up.json" -w '%{http_code}' -X POST "$BASE/admin/bank/import?subjectCode=$1&filename=$(basename "$2")$3" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/octet-stream' --data-binary @"$2"; }
check "试解析（dryRun）→ 200，题数和文件一致" "$(up pecopy "$TEST2" '&dryRun=1')/$(jq -r '.questions' "$WORK/up.json")" "200/$N_FILE"
check "试解析不写库" "$(one "SELECT COUNT(*) FROM exams WHERE course_code = 'pecopy-main';")" "0"
check "上传样卷 2 → 200" "$(up pecopy "$TEST2" '')" "200"
G1=$(jq -r '.groupId' "$WORK/up.json")
TODAY=$(TZ=Asia/Shanghai date +%Y%m%d)
check "内容组编号 = 学科码-北京日期-1" "$G1" "pecopy-$TODAY-1"
check "排序键默认 = 现有最大值 + 10（第一组是 10）" "$(one "SELECT order_key FROM exams WHERE exam_id = '$G1';")" "10"
check "题数 $N_FILE 和文件一致" "$(one "SELECT COUNT(*) FROM questions WHERE exam_id = '$G1';")" "$N_FILE"
check "得分单元 $N_ITEMS 个和文件一致" "$(one "SELECT COUNT(*) FROM question_items i JOIN questions q ON q.question_id = i.question_id WHERE q.exam_id = '$G1';")" "$N_ITEMS"
check "答案状态照文件：$N_CONF 道已确认" "$(one "SELECT COUNT(*) FROM questions WHERE exam_id = '$G1' AND answer_state = '已确认';")" "$N_CONF"
check "篇章原文带进来了（有原文的大题数和文件一致）" \
  "$(one "SELECT COUNT(*) FROM sections WHERE exam_id = '$G1' AND passage_text IS NOT NULL AND passage_text <> '';")" \
  "$(jq '[.sections[] | select((.passageText // "") != "")] | length' "$TEST2")"
check "题目编号按本次导入重写，不和公共英语自己的撞" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id = '$G1' AND question_id NOT LIKE '$G1-q%';")" "0"
check "来源记成 UPLOAD（可整组删除）" "$(one "SELECT origin FROM exams WHERE exam_id = '$G1';")" "UPLOAD"
check "考点按学科挂上了（每道题都有考点）" \
  "$(one "SELECT COUNT(*) FROM questions q WHERE q.exam_id = '$G1' AND NOT EXISTS (SELECT 1 FROM question_knowledge_points x WHERE x.question_id = q.question_id);")" \
  "$(jq '[.sections[].questions[] | select((.knowledgePoints // []) | length == 0)] | length' "$TEST2")"
check "再传一次 → 编号 -2、排序键 20" "$(up pecopy "$TEST2" '')/$(jq -r '.groupId' "$WORK/up.json")/$(jq -r '.orderKey' "$WORK/up.json")" "200/pecopy-$TODAY-2/20"
G2=$(jq -r '.groupId' "$WORK/up.json")
check "传进没声明这些题型的学科（通用课）→ 422 question_type_not_declared" "$(up gen01 "$TEST2" '')/$(jq -r '.error' "$WORK/up.json")" "422/question_type_not_declared"
echo '{不是 json' > "$WORK/bad.json"
check "不是 JSON → 422 bad_json" "$(up pecopy "$WORK/bad.json" '')/$(jq -r '.error' "$WORK/up.json")" "422/bad_json"
jq '.sections[0].questions[0].assets = [{"key":"fig1","kind":"IMAGE","path":"x.png","alt":"图"}]' "$TEST2" > "$WORK/assets.json"
check "题干带图 → 422 assets_not_supported" "$(up pecopy "$WORK/assets.json" '')/$(jq -r '.error' "$WORK/up.json")" "422/assets_not_supported"
check "被拒的几次一行都没写（pecopy 仍是两组）" "$(one "SELECT COUNT(*) FROM exams WHERE course_code = 'pecopy-main';")" "2"
check "学科列表里公共英语副本可上传，接受 .json" \
  "$(A "$BASE/admin/subjects" | jq -r '.subjects[] | select(.code == "pecopy") | "\(.uploadable)/\(.uploadAccepts)"')" "true/.json"

echo
echo "== B 组卷模板 =="
A "$BASE/admin/subjects/$CP_ID/template" > "$WORK/tpl0.json"
check "新课还没有模板，版本号 0" "$(jq -r '"\(.items | length)/\(.version)"' "$WORK/tpl0.json")" "0/0"
check "下拉选项里的题型来自本学科声明" "$(jq -r '[.choices.questionTypes[].code] | sort | join(",")' "$WORK/tpl0.json")" \
  "$(one "SELECT group_concat(type_code, ',') FROM (SELECT type_code FROM subject_question_types WHERE subject_id = $CP_ID ORDER BY type_code);")"
check "按样卷生成草稿 → 200" "$(code -X POST "$BASE/admin/subjects/$CP_ID/template/draft" -H "Authorization: Bearer $ADMIN" -d "{\"examId\":\"$G1\"}")" "200"
cp "$WORK/last.json" "$WORK/draft.json"
jq -r '.items | sort_by(.ord)[] | [.label, (.filter | tojson), .pickUnit, .questionCount] | @tsv' "$TPL_JSON" > "$WORK/draft-want.tsv"
jq -r '.items[] | [.label, (.filter | tojson), .pickUnit, .questionCount] | @tsv' "$WORK/draft.json" > "$WORK/draft-got.tsv"
check "草稿 $(wc -l < "$WORK/draft-want.tsv") 行的名称、筛选、抽法、题数和 exam-template.json 逐行一致" \
  "$(diff "$WORK/draft-want.tsv" "$WORK/draft-got.tsv" >/dev/null && echo 一致 || { diff "$WORK/draft-want.tsv" "$WORK/draft-got.tsv" | head -6; echo 不一致; })" "一致"
check "草稿的分值留空，等人照试卷说明填" "$(jq -r '[.items[].scorePerQuestion] | map(select(. != null)) | length' "$WORK/draft.json")" "0"
check "草稿不落库" "$(one "SELECT COUNT(*) FROM exam_template_items WHERE course_code = 'pecopy-main';")" "0"

# 按模板文件填上分值保存
ITEMS=$(jq -c '[.items | sort_by(.ord)[] | {label, filter, pickUnit, questionCount, scorePerQuestion}]' "$TPL_JSON")
put_tpl() { code -X PUT "$BASE/admin/subjects/$CP_ID/template" -H "Authorization: Bearer $ADMIN" -d "$(jq -nc --argjson i "$1" --argjson v "$2" '{items:$i,version:$v}')"; }
check "保存模板（照模板文件的分值）→ 200" "$(put_tpl "$ITEMS" 0)" "200"
check "保存后版本号 1、合计等于满分" "$(jq -r '"\(.version)/\(.total)/\(.expected)"' "$WORK/last.json")" "1/$(jq -r '.totalScore' "$TPL_JSON")/100"
check "库里的模板和文件逐项一致" \
  "$(sql "SELECT label, filter, question_count, score_per_question, pick_unit FROM exam_template_items WHERE course_code = 'pecopy-main' ORDER BY ord;" \
     | jq -c '[.[0].results[] | [.label, (.filter | fromjson), .question_count, .score_per_question, .pick_unit]]')" \
  "$(jq -c '[.items | sort_by(.ord)[] | [.label, .filter, .questionCount, .scorePerQuestion, .pickUnit]]' "$TPL_JSON")"
check "保存后带着体检（readiness）" "$(jq -r '.readiness.parts | length' "$WORK/last.json")" "$(jq '.items | length' "$TPL_JSON")"
check "拿旧版本号再保存 → 409 template_changed" "$(put_tpl "$ITEMS" 0)/$(jq -r '.error' "$WORK/last.json")" "409/template_changed"
check "409 时模板一行没动、版本号还是 1" \
  "$(one "SELECT COUNT(*) || '/' || (SELECT template_version FROM courses WHERE course_code = 'pecopy-main') FROM exam_template_items WHERE course_code = 'pecopy-main';")" \
  "$(jq '.items | length' "$TPL_JSON")/1"
LESS=$(echo "$ITEMS" | jq -c '.[0].scorePerQuestion = 0.25 | .[0].questionCount = 20 | .[0].scorePerQuestion = 0.5 | .[1].questionCount = 5')
check "合计不等于满分 → 422，说清差几分" "$(put_tpl "$LESS" 1)/$(jq -r '.message | test("还差 5 分")' "$WORK/last.json")" "422/true"
BADPICK=$(echo "$ITEMS" | jq -c '.[0].pickUnit = "SECTION"')
check "按题型筛却选整篇抽 → 422" "$(put_tpl "$BADPICK" 1)" "422"
BADTYPE=$(echo "$ITEMS" | jq -c '.[0].filter = {questionTypes:["essay"]}')
check "选了本学科没有的题型 → 422" "$(put_tpl "$BADTYPE" 1)" "422"
HALF=$(echo "$ITEMS" | jq -c '.[0].scorePerQuestion = 0.3')
check "分值不是 0.5 的倍数 → 422" "$(put_tpl "$HALF" 1)" "422"
check "改模板写了审计（含改之前的样子）" "$(one "SELECT COUNT(*) FROM admin_audit WHERE action = 'template.update' AND target = 'pecopy-main' AND before_json = '[]';")" "1"

echo
echo "== A4 改课程满分、时长 =="
check "满分改成 90 → 200，并提示模板对不上" \
  "$(code -X PATCH "$BASE/admin/courses/pecopy-main" -H "Authorization: Bearer $ADMIN" -d '{"totalScore":90}')/$(jq -c '.templateMismatch' "$WORK/last.json")" \
  "200/{\"total\":100,\"expected\":90}"
check "线上验证会看到这门课模板合计 ≠ 满分" \
  "$(A "$BASE/admin/bank/exam-readiness" | jq -r '.courses[] | select(.courseCode == "pecopy-main") | "\(.templateTotal)/\(.totalScore)"')" "100/90"
check "改回 100 → 不再提示" "$(code -X PATCH "$BASE/admin/courses/pecopy-main" -H "Authorization: Bearer $ADMIN" -d '{"totalScore":100}')/$(jq -c '.templateMismatch' "$WORK/last.json")" "200/null"
check "时长超出范围 → 400" "$(code -X PATCH "$BASE/admin/courses/pecopy-main" -H "Authorization: Bearer $ADMIN" -d '{"timeLimitMinutes":5}')" "400"

echo
echo "== L 上线清单 + E 一键发布 =="
A "$BASE/admin/subjects/$CP_ID/checklist" > "$WORK/cl1.json"
check "发布前：状态是还不能用" "$(jq -r '.state' "$WORK/cl1.json")" "not_usable"
check "待确认题数从库里现算" "$(jq -r '.items.pendingAnswers' "$WORK/cl1.json")" \
  "$(one "SELECT COUNT(*) FROM questions WHERE course_code = 'pecopy-main' AND answer_state <> '已确认' AND retired_at IS NULL;")"
check "两组都待发布" "$(jq -r '.items.unpublishedGroups' "$WORK/cl1.json")" "2"
check "一键发布 → 200，两组都发了、没有剩下" \
  "$(code -X POST "$BASE/admin/subjects/$CP_ID/publish-all" -H "Authorization: Bearer $ADMIN" -d '{}')/$(jq -r '"\(.published | length)/\(.remaining)"' "$WORK/last.json")" "200/2/0"
check "发布了的题数 = 已确认的题数（待核的扣下）" \
  "$(one "SELECT COUNT(*) FROM questions WHERE course_code = 'pecopy-main' AND status = '已发布';")" "$((N_CONF * 2))"
check "一键发布写了审计" "$(one "SELECT COUNT(*) FROM admin_audit WHERE action = 'subject.publish_all' AND subject_id = $CP_ID;")" "1"
A "$BASE/admin/subjects/$CP_ID/checklist" > "$WORK/cl2.json"
check "发布后不再有待发布的组" "$(jq -r '.items.unpublishedGroups' "$WORK/cl2.json")" "0"
# 待核的翻译题没发布：句子翻译凑不够就组不出卷 → 能练习、还不能模考
SENT_OK=$(one "SELECT COUNT(*) FROM questions WHERE course_code = 'pecopy-main' AND question_type = 'sentence_translate' AND status = '已发布';")
WANT_SENT=$(jq -r '[.items[] | select(.filter.questionTypes // [] | index("sentence_translate")) | .questionCount] | add' "$TPL_JSON")
check "（前提）已发布的句子翻译 $SENT_OK 道 < 模板要的 $WANT_SENT 道" "$([ "$SENT_OK" -lt "$WANT_SENT" ] && echo 是 || echo 否)" "是"
check "所以状态是能练习、还不能模考" "$(jq -r '.state' "$WORK/cl2.json")" "practice_only"
check "清单里点名了句子翻译凑不够" "$(jq -r '.summary | test("句子翻译")' "$WORK/cl2.json")" "true"
check "后台首页的清单里有这门课" "$(A "$BASE/admin/checklists" | jq -r '[.checklists[].subject.code] | index("pecopy") != null')" "true"
# 一键发布分批：造 6 个只有 1 道题的小组
jq '.sections = [.sections[0] | .questions = [.questions[0]]] | .answerState = "已确认" | .answerSource = "MANUAL"
    | .sections[0].questions[0].answerState = "已确认"' "$TEST2" > "$WORK/mini.json"
for i in 1 2 3 4 5 6; do up pecopy "$WORK/mini.json" '' >/dev/null; done
check "6 组待发布：第一批发 5 组、剩 1" \
  "$(code -X POST "$BASE/admin/subjects/$CP_ID/publish-all" -H "Authorization: Bearer $ADMIN" -d '{}')/$(jq -r '"\(.published | length)/\(.remaining)"' "$WORK/last.json")" "200/5/1"
check "第二批发完" \
  "$(code -X POST "$BASE/admin/subjects/$CP_ID/publish-all" -H "Authorization: Bearer $ADMIN" -d '{}')/$(jq -r '"\(.published | length)/\(.remaining)"' "$WORK/last.json")" "200/1/0"

echo
echo "== E2 新学员自动开通 =="
check "打开公共英语副本的自动开通 → 200" \
  "$(code -X PUT "$BASE/admin/subjects/$CP_ID/settings/auto-grant" -H "Authorization: Bearer $ADMIN" -d '{"enabled":true}')" "200"
newuser() { A -X POST "$BASE/admin/users" -d "$1" | jq -r '.grantedSubjects | sort | join(",")'; }
check "建学员不带 subjects → 自动开通公共英语副本" "$(newuser '{"username":"PH2S02"}')" "pecopy"
check "建学员 subjects: [] → 一个都不开" "$(newuser '{"username":"PH2S03","subjects":[]}')" ""
check "建学员带 subjects → 照传入的开" "$(newuser '{"username":"PH2S04","subjects":["biochem"]}')" "biochem"
A -X PATCH "$BASE/admin/subjects/$CP_ID" -d '{"status":"停用"}' >/dev/null
check "学科停用后不再自动开通" "$(newuser '{"username":"PH2S05"}')" ""
A -X PATCH "$BASE/admin/subjects/$CP_ID" -d '{"status":"启用"}' >/dev/null
# 能力包页保存参数会先删掉这个学科的全部参数覆盖——开关放在 subjects 的列上，不受影响
A -X PUT "$BASE/admin/subjects/$CP_ID/pack/settings" -d '{"settings":[]}' >/dev/null
check "能力包页保存一次参数，自动开通开关还在" "$(one "SELECT auto_grant_new_users FROM subjects WHERE subject_id = $CP_ID;")" "1"
check "开关 enabled 不是布尔值 → 400" "$(code -X PUT "$BASE/admin/subjects/$CP_ID/settings/practice-ai" -H "Authorization: Bearer $ADMIN" -d '{"enabled":"yes"}')" "400"
check "关掉练习 AI 批改 → 库里是 0" \
  "$(code -X PUT "$BASE/admin/subjects/$CP_ID/settings/practice-ai" -H "Authorization: Bearer $ADMIN" -d '{"enabled":false}')/$(one "SELECT practice_ai_grading FROM subjects WHERE subject_id = $CP_ID;")" "200/0"

echo
echo "== C3 每月花费上限 =="
check "没设上限时 budget 是 null" "$(A "$BASE/admin/ai/budget" | jq -r '.budget')" "null"
check "设成 20 元 → 200" "$(code -X PUT "$BASE/admin/ai/budget" -H "Authorization: Bearer $ADMIN" -d '{"yuan":20}')/$(jq -r '.budget' "$WORK/last.json")" "200/20"
check "上限不是正数 → 400" "$(code -X PUT "$BASE/admin/ai/budget" -H "Authorization: Bearer $ADMIN" -d '{"yuan":-1}')" "400"
check "能力包页照样读得出（上限这一行是数字，不会让参数表读挂）" "$(code "$BASE/admin/subjects/$PE_ID/pack" -H "Authorization: Bearer $ADMIN")" "200"
check "改成不设上限 → null" "$(code -X PUT "$BASE/admin/ai/budget" -H "Authorization: Bearer $ADMIN" -d '{"yuan":null}')/$(jq -r '.budget' "$WORK/last.json")" "200/null"
check "改上限写了审计" "$(one "SELECT COUNT(*) FROM admin_audit WHERE action = 'ai.budget';")" "2"

echo
echo "== 评价标准：有采分点题型的学科不能删掉 pointCorrectThreshold =="
RUB=$(one "SELECT payload FROM subject_rubrics WHERE subject_id = $PE_ID AND is_current = 1;")
check "删掉这一项保存 → 400" \
  "$(code -X PUT "$BASE/admin/subjects/$PE_ID/pack/rubric" -H "Authorization: Bearer $ADMIN" -d "$(jq -nc --argjson p "$RUB" '{payload: ($p | del(.mastery.pointCorrectThreshold))}')")" "400"
check "改成 0～1 之外 → 400" \
  "$(code -X PUT "$BASE/admin/subjects/$PE_ID/pack/rubric" -H "Authorization: Bearer $ADMIN" -d "$(jq -nc --argjson p "$RUB" '{payload: ($p | .mastery.pointCorrectThreshold = 2)}')")" "400"
check "英语没有采分点题型，不要求这一项" \
  "$(code -X PUT "$BASE/admin/subjects/$(one "SELECT subject_id FROM subjects WHERE code = 'english';")/pack/rubric" -H "Authorization: Bearer $ADMIN" \
     -d "$(jq -nc --argjson p "$(one "SELECT payload FROM subject_rubrics r JOIN subjects s ON s.subject_id = r.subject_id WHERE s.code = 'english' AND r.is_current = 1;")" '{payload: ($p | del(.mastery.pointCorrectThreshold))}')")" "200"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
exit $([ "$FAIL" = 0 ] && echo 0 || echo 1)
