#!/usr/bin/env bash
# N6：内容组织维度（§6.4.2）与答案状态（§6.4.10、B14）。
#
# 这一套要两个学科的数据同时在库里才有意义：英语是"年月内容组 + 官方答案"，
# 生化是"章节内容组 + AI 待核答案"。只有英语的话，order_key 与 year*100+month
# 永远相等，label 与 title 永远相等，答案状态永远是已确认——
# **所有断言都会以恒等式的形式通过**。
#
# 判分规则本身不在这里测（grade-items.test.mjs），导入器也不在（docx-import.test.mjs）。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8783          # 端口表见 CLAUDE.md
BASE="http://localhost:$PORT/api"
BIO_SEED=/tmp/n6-seed-bio
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
cols() { sql "SELECT group_concat(name) AS c FROM pragma_table_info('$1');" | jq -r '.[0].results[0].c // empty' | tr ',' '\n' | sort | tr '\n' ' '; }

cleanup() {
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$ROOT_DIR/.wrangler"; rm -f "$ROOT_DIR/.dev.vars"; rm -rf "$BIO_SEED"
}
trap cleanup EXIT

if [ ! -d public ]; then
  echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1
fi

echo "== 准备本地数据库（英语 + 生化） =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-n6
SETUP_TOKEN=test-setup-n6
ENCRYPTION_KEY=test-encryption-key-n6
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
# 先重新生成英语的种子。**这一套测的是种子 SQL 本身的语义**（清理段只清 SEED、
# 内容组带 origin），而 worker/seed/ 是构建产物、不进 git——改了生成器不重新生成的话，
# 这里导进去的是上一次留下的旧 SQL，断言照样跑、照样绿，测的却是旧行为。
# 我就是这么让 origin 那四条断言"通过"了一轮的。
SEED_SUBJECT_DIR="$ROOT_DIR/../data/subjects/english" \
  node ../scripts/build-seed-sql.mjs >/dev/null 2>&1 \
  || { echo "英语种子生成失败"; exit 1; }
npx wrangler d1 execute "$D1_NAME" --local --file=seed/english-000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "找不到 $EXAM 的种子，先跑 node scripts/build-seed-sql.mjs"; exit 1; }
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
# 生化的种子不在 worker/seed 里（流水线只导英语，见需求文档 N6 实现说明第 6 条），
# 这里现生成一份。它同时也是"种子生成器认得第二种内容组形状"的检验。
rm -rf "$BIO_SEED"
SEED_SUBJECT_DIR="$ROOT_DIR/../data/subjects/biochem" \
  node ../scripts/build-seed-sql.mjs "$BIO_SEED" > /tmp/n6-seed.log 2>&1 \
  || { echo "生化种子生成失败："; cat /tmp/n6-seed.log; exit 1; }
for f in "$BIO_SEED"/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$f" >/dev/null 2>&1 || { echo "导入 $f 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

echo
echo "== 两个学科的数据都在（否则下面全是恒等式） =="
EN_GROUPS=$(one "SELECT COUNT(*) FROM exams WHERE course_code='13000';")
BIO_GROUPS=$(one "SELECT COUNT(*) FROM exams WHERE course_code='biochem-main';")
check "英语内容组导进来了" "$([ "${EN_GROUPS:-0}" -ge 4 ] && echo 有 || echo 无)" "有"
check "生化内容组导进来了" "$([ "${BIO_GROUPS:-0}" -ge 1 ] && echo 有 || echo 无)" "有"
check "生化的题也进来了" "$(one "SELECT COUNT(*) FROM questions WHERE course_code='biochem-main';")" "34"
check "生化的得分单元也进来了" "$(one "SELECT COUNT(*) FROM question_items q JOIN questions x ON x.question_id=q.question_id WHERE x.course_code='biochem-main';")" "82"
check "生化的题挂上了学科" "$(one "SELECT COUNT(*) FROM questions WHERE course_code='biochem-main' AND subject_id IS NULL;")" "0"

echo
echo "== §6.4.2 内容组织维度 =="
for c in order_key label meta; do
  check "exams 有 $c 列" "$(cols exams | grep -cw "$c")" "1"
done
check "没有内容组缺 order_key" "$(one 'SELECT COUNT(*) FROM exams WHERE order_key IS NULL;')" "0"
check "没有内容组缺 label"     "$(one 'SELECT COUNT(*) FROM exams WHERE label IS NULL;')" "0"
# 期望值从 year/month 现算，不写死：写死的话换一套卷子就要改测试
check "英语的 order_key = year*100+month" \
  "$(one "SELECT COUNT(*) FROM exams WHERE course_code='13000' AND order_key <> year*100+month;")" "0"
check "生化的 order_key 是章节号" \
  "$(one "SELECT order_key FROM exams WHERE exam_id='biochem-ch01';")" "1"
check "生化没有年月（库里写 0）" \
  "$(one "SELECT year || '/' || month FROM exams WHERE exam_id='biochem-ch01';")" "0/0"
check "生化的 meta 记了章节号" \
  "$(sql "SELECT meta FROM exams WHERE exam_id='biochem-ch01';" | jq -r '.[0].results[0].meta' | jq -r '.chapterNo')" "1"
check "生化的 label 是章节名" \
  "$(one "SELECT label FROM exams WHERE exam_id='biochem-ch01';")" "第01章 蛋白质的化学"
# order_key 是唯一的结构性字段，所以两个学科的内容组能放在一条 SQL 里排序。
# 断言"排得出来"没意义（什么都排得出来），要断的是它把两科排进了同一个序列。
check "两科的内容组能用同一条 SQL 排序" \
  "$(one "SELECT COUNT(DISTINCT course_code) FROM (SELECT course_code FROM exams ORDER BY order_key DESC LIMIT 100);")" "2"

echo
echo "== §6.4.10 答案状态 =="
for c in answer_state answer_source answer_reviewed_by answer_reviewed_at; do
  check "questions 有 $c 列" "$(cols questions | grep -cw "$c")" "1"
done
for c in note_kind corrected_from corrected_to corrected_by corrected_at; do
  check "exam_parsing_notes 有 $c 列" "$(cols exam_parsing_notes | grep -cw "$c")" "1"
done
check "英语的答案全是已确认" \
  "$(one "SELECT COUNT(*) FROM questions WHERE course_code='13000' AND answer_state <> '已确认';")" "0"
check "生化没有一道题的答案是已确认的" \
  "$(one "SELECT COUNT(*) FROM questions WHERE course_code='biochem-main' AND answer_state <> '待核';")" "0"
check "生化的答案来源是 AI" \
  "$(one "SELECT DISTINCT answer_source FROM questions WHERE course_code='biochem-main';")" "AI"
check "英语的答案来源是官方" \
  "$(one "SELECT DISTINCT answer_source FROM questions WHERE course_code='13000';")" "OFFICIAL"
check "待核的答案没有确认留痕" \
  "$(one "SELECT COUNT(*) FROM questions WHERE answer_state <> '已确认' AND answer_reviewed_by IS NOT NULL;")" "0"
# 原题有误与解析存疑要分得开，而且订正前后都在
check "生化记了一条原题有误" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE exam_id='biochem-ch01' AND note_kind='原题有误';")" "1"
check "原题有误带订正前后" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE note_kind='原题有误' AND (corrected_from IS NULL OR corrected_to IS NULL);")" "0"
check "英语那些自由文本记录落成解析存疑" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE exam_id LIKE '%2015-04' AND note_kind <> '解析存疑';")" "0"
# 已经订正好的题不该被永久扣下（见需求文档 N6 实现说明第 4 条）
check "被订正的第 21 题不是存疑" \
  "$(one "SELECT status FROM questions WHERE question_id='biochem-ch01-q21';")" "草稿"
# 期望值从**源文件**算，不是从库里另查一遍：库里那份就是被测代码写进去的，
# 拿它对自己是恒等式。这里重算的是"哪些记录该扣题"这条规则
# （原题有误且留了订正前后的不扣，见需求文档 N6 实现说明第 4 条）。
BIO_JSON="$ROOT_DIR/../data/subjects/biochem/groups/biochem-ch01.json"
BIO_TOTAL=$(jq '[.sections[].questions[]] | length' "$BIO_JSON")
BIO_FLAGGED=$(jq '[.parsingNotes[] | select(type=="object")
  | select(((.kind == "原题有误") and (.correctedFrom != null) and (.correctedTo != null)) | not)
  | (.questionOrders // [])[]] | unique | length' "$BIO_JSON")
check "源文件里确实有 34 道题（否则下面都是空断言）" "$BIO_TOTAL" "34"
check "被答案存疑点名的题是存疑" \
  "$(one "SELECT COUNT(*) FROM questions WHERE course_code='biochem-main' AND status='存疑';")" "$BIO_FLAGGED"
check "被点名的不止一道" "$([ "${BIO_FLAGGED:-0}" -ge 2 ] && echo 是 || echo 否)" "是"

echo
echo "== B14：缺答案的题不参与组卷与练习抽题 =="
# publish-all 已经跑过了。生化 34 道全是待核，所以一道都不该被放行。
check "publish-all 没有放行任何待核的题" \
  "$(one "SELECT COUNT(*) FROM questions WHERE course_code='biochem-main' AND status='已发布';")" "0"
check "英语该放行的都放行了（否则上一条是空断言）" \
  "$([ "$(one "SELECT COUNT(*) FROM questions WHERE course_code='13000' AND status='已发布';")" -ge 100 ] && echo 有 || echo 无)" "有"

echo "== 启动服务 =="
DEV_LOG=/tmp/n6-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }
echo "  服务已就绪"

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-n6' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin12345"}' | jq -r '.token')
[ "$ADMIN" != "null" ] && [ -n "$ADMIN" ] || { echo "管理员登录失败"; exit 1; }
STU_PASS=$(admj -X POST "$BASE/admin/users" \
  -d '{"username":"T601","subjects":["english","biochem"]}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "{\"username\":\"T601\",\"password\":\"$STU_PASS\"}" | jq -r '.token')
stu()  { curl -s -H "Authorization: Bearer $STU" "$@"; }
stuj() { curl -s -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' "$@"; }

echo
echo "== 接口层：0 不出库，排序走 order_key =="
adm "$BASE/admin/bank/exams" > /tmp/n6-exams.json
check "生化内容组的 year 读出来是 null" \
  "$(jq -r '.exams[] | select(.exam_id=="biochem-ch01") | .year' /tmp/n6-exams.json)" "null"
check "生化内容组的 month 读出来是 null" \
  "$(jq -r '.exams[] | select(.exam_id=="biochem-ch01") | .month' /tmp/n6-exams.json)" "null"
check "英语内容组的年月照常读得到" \
  "$(jq -r '.exams[] | select(.exam_id=="13000-2026-04") | "\(.year)/\(.month)"' /tmp/n6-exams.json)" "2026/4"
check "meta 读出来是对象不是字符串" \
  "$(jq -r '.exams[] | select(.exam_id=="biochem-ch01") | .meta | type' /tmp/n6-exams.json)" "object"
# 返回顺序要与按 order_key 降序排出来的顺序一致。期望值从同一份返回里现算，
# 但算的是**另一个字段**（order_key），不是把返回顺序抄一遍。
check "列表按 order_key 降序" \
  "$(jq -r '[.exams[].exam_id] | join(",")' /tmp/n6-exams.json)" \
  "$(jq -r '[.exams[] | {id:.exam_id, k:.order_key}] | sort_by(-.k) | [.[].id] | join(",")' /tmp/n6-exams.json)"
check "缺答案题数出现在列表上" \
  "$(jq -r '.exams[] | select(.exam_id=="biochem-ch01") | .missing_answer_count' /tmp/n6-exams.json)" "34"
check "英语那几套没有缺答案" \
  "$(jq -r '[.exams[] | select(.course_code=="13000") | .missing_answer_count] | add' /tmp/n6-exams.json)" "0"
adm "$BASE/admin/bank/stats" > /tmp/n6-stats.json
check "看板按学科分开数待核题" \
  "$(jq -r '.byAnswerState[] | select(.subject_code=="biochem") | .unreviewed' /tmp/n6-stats.json)" "34"
check "看板里英语的已确认题数非零" \
  "$([ "$(jq -r '.byAnswerState[] | select(.subject_code=="english") | .confirmed' /tmp/n6-stats.json)" -gt 0 ] && echo 有 || echo 无)" "有"

echo
echo "== B14：抽题路径逐条 =="
# 挑样本：取一个**只挂着一道可抽题**的考点。挑题量最多的那个测不出东西——
# 拿掉一道之后它还剩几十道，什么都不会变。可达性由 question_count 决定，
# 所以把它打出来（CLAUDE.md 的规矩）。
SCOPE0=$(stu "$BASE/practice/scope?courseCode=13000")
LONE_TAG=$(echo "$SCOPE0" | jq -r '[.knowledgePoints[] | select(.question_count == 1)] | .[0].tag_id // empty')
if [ -z "$LONE_TAG" ]; then
  LONE_TAG=$(echo "$SCOPE0" | jq -r '[.knowledgePoints[]] | sort_by(.question_count) | .[0].tag_id // empty')
fi
LONE_N=$(echo "$SCOPE0" | jq -r --arg t "$LONE_TAG" '.knowledgePoints[] | select(.tag_id==$t) | .question_count')
LONE_NAME=$(echo "$SCOPE0" | jq -r --arg t "$LONE_TAG" '.knowledgePoints[] | select(.tag_id==$t) | .name')
echo "     （挑中的考点：$LONE_NAME，题量 $LONE_N —— 决定可达性的就是这个数）"
check "挑到的考点题量确实最少（否则下面测的是题库深度）" \
  "$([ "${LONE_N:-99}" -le 3 ] && echo 是 || echo 否)" "是"
COUNT0=$(echo "$SCOPE0" | jq -r '.questionCount')
TYPES0=$(stu "$BASE/practice/section-types?courseCode=13000" | jq -r '[.sectionTypes[].question_count] | add')

# 把这个考点下的题全部改成缺答案
exec_sql "UPDATE questions SET answer_state='缺答案'
  WHERE question_id IN (SELECT question_id FROM question_knowledge_points WHERE tag_id='$LONE_TAG')
    AND course_code='13000';"
SCOPE1=$(stu "$BASE/practice/scope?courseCode=13000")
check "缺答案之后该考点从可练范围里消失" \
  "$(echo "$SCOPE1" | jq -r --arg t "$LONE_TAG" '[.knowledgePoints[] | select(.tag_id==$t)] | length')" "0"
check "可练题数少了正好这些题" \
  "$(echo "$SCOPE1" | jq -r '.questionCount')" "$((COUNT0 - LONE_N))"
check "题型清单里的题数也跟着少" \
  "$(stu "$BASE/practice/section-types?courseCode=13000" | jq -r '[.sectionTypes[].question_count] | add')" "$((TYPES0 - LONE_N))"
# 改回去，后面的组卷断言要一个完整的题库
exec_sql "UPDATE questions SET answer_state='已确认'
  WHERE question_id IN (SELECT question_id FROM question_knowledge_points WHERE tag_id='$LONE_TAG')
    AND course_code='13000';"
check "改回去之后可练题数复原" \
  "$(stu "$BASE/practice/scope?courseCode=13000" | jq -r '.questionCount')" "$COUNT0"

# 组卷这条路单独走一遍：它用的是另一段 SQL（candidateSections / candidateQuestions），
# 练习那条过了不代表它也过（CLAUDE.md：每种路径形状都要单独断一条）。
GEN0=$(stuj -X POST "$BASE/exams/generate" -d '{"courseCode":"13000"}')
check "题库完整时组得出卷" "$(echo "$GEN0" | jq -r 'if .attemptId then "能" else .error end')" "能"
exec_sql "UPDATE questions SET answer_state='缺答案' WHERE course_code='13000';"
GEN1=$(stuj -X POST "$BASE/exams/generate" -d '{"courseCode":"13000"}')
check "全库缺答案时组卷被拒" "$(echo "$GEN1" | jq -r '.error')" "insufficient_questions"
check "拒绝信息说得出是哪个部分不够" \
  "$([ -n "$(echo "$GEN1" | jq -r '.message // empty')" ] && echo 有 || echo 无)" "有"
exec_sql "UPDATE questions SET answer_state='已确认' WHERE course_code='13000';"
check "改回去之后又组得出卷" \
  "$(stuj -X POST "$BASE/exams/generate" -d '{"courseCode":"13000"}' | jq -r 'if .attemptId then "能" else .error end')" "能"

echo
echo "== 发布门：答案没确认就发不出去（§6.4.10 的硬约束） =="
BIO_Q=biochem-ch01-q01
check "这道题现在是待核" "$(one "SELECT answer_state FROM questions WHERE question_id='$BIO_Q';")" "待核"
RESP=$(admj -X PATCH "$BASE/admin/bank/questions/$BIO_Q" -d '{"status":"已发布"}')
check "直接发布被拒" "$(echo "$RESP" | jq -r '.error')" "answer_not_confirmed"
check "拒绝时说清楚当前是哪一格" "$(echo "$RESP" | jq -r '.answerState')" "待核"
check "被拒之后状态没变" "$(one "SELECT status FROM questions WHERE question_id='$BIO_Q';")" "草稿"
check "非法的答案状态被拒" \
  "$(admj -X PATCH "$BASE/admin/bank/questions/$BIO_Q" -d '{"answerState":"差不多了"}' | jq -r '.error')" "invalid_answer_state"
check "非法的答案来源被拒" \
  "$(admj -X PATCH "$BASE/admin/bank/questions/$BIO_Q" -d '{"answerSource":"随便"}' | jq -r '.error')" "invalid_answer_source"
# 同一次请求里先确认再发布：只看库里的旧值会把这种请求误拒
check "确认与发布可以一次提交" \
  "$(admj -X PATCH "$BASE/admin/bank/questions/$BIO_Q" -d '{"answerState":"已确认","status":"已发布"}' | jq -r '.ok')" "true"
check "确认之后真的发出去了" "$(one "SELECT status FROM questions WHERE question_id='$BIO_Q';")" "已发布"
check "留痕记下了是谁确认的" "$(one "SELECT answer_reviewed_by FROM questions WHERE question_id='$BIO_Q';")" "admin"
check "留痕记下了时间" \
  "$([ -n "$(one "SELECT answer_reviewed_at FROM questions WHERE question_id='$BIO_Q';")" ] && echo 有 || echo 无)" "有"
# 退回未确认时留痕要清掉，否则界面上会挂着一个早就作废的"某某已确认"
admj -X PATCH "$BASE/admin/bank/questions/$BIO_Q" -d '{"answerState":"待核"}' >/dev/null
check "退回未确认后留痕清掉" \
  "$(one "SELECT COALESCE(answer_reviewed_by,'空') FROM questions WHERE question_id='$BIO_Q';")" "空"
check "退回之后它仍然是已发布状态（两个维度互不覆盖）" \
  "$(one "SELECT status FROM questions WHERE question_id='$BIO_Q';")" "已发布"
check "但它已经抽不到了（判据看的是当下的答案状态，不是发布时的）" \
  "$(one "SELECT COUNT(*) FROM questions WHERE question_id='$BIO_Q' AND status='已发布' AND answer_state='已确认';")" "0"
exec_sql "UPDATE questions SET status='草稿' WHERE question_id='$BIO_Q';"

echo
echo "== 整卷发布：待核的题扣下，并且说出来 =="
for id in $(sql "SELECT id FROM exam_parsing_notes WHERE exam_id='biochem-ch01';" | jq -r '.[0].results[].id'); do
  admj -X PATCH "$BASE/admin/bank/notes/$id" -d '{"resolved":true}' >/dev/null
done
# publish-all 只放行真有题上线的内容组，所以这一章现在还是待校对。
# 它同时也是那条规则的断言：全组待核时内容组不该被标成已发布。
check "一道题都没上线的章节没有被标成已发布" \
  "$(one "SELECT status FROM exams WHERE exam_id='biochem-ch01';")" "待校对"
# 同样从源文件算：全组都是待核，所以该扣的就是"总题数减去被扣成存疑的那几道"。
EXPECT_HELD_NO_ANSWER=$((BIO_TOTAL - BIO_FLAGGED))
PUB=$(admj -X POST "$BASE/admin/bank/exams/biochem-ch01/publish")
check "一道都没发出去" "$(echo "$PUB" | jq -r '.published')" "0"
check "扣下的题数说出来了" "$(echo "$PUB" | jq -r '.heldNoAnswer')" "$EXPECT_HELD_NO_ANSWER"
check "扣下的不止一道（否则上一条可能是巧合）" \
  "$([ "${EXPECT_HELD_NO_ANSWER:-0}" -ge 20 ] && echo 是 || echo 否)" "是"
check "提示语里点了题号" \
  "$([ -n "$(echo "$PUB" | jq -r '.message // empty')" ] && echo 有 || echo 无)" "有"
check "内容组自己变成已发布（章节可以先挂上）" \
  "$(one "SELECT status FROM exams WHERE exam_id='biochem-ch01';")" "已发布"
check "题一道都没进已发布" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id='biochem-ch01' AND status='已发布';")" "0"
# 确认三道之后再发一次，这三道才进去。
# **挑题要挑没被扣成存疑的**：按 id 顺序取前三道（q01/q02/q03）会踩到 q02——
# 它被一条"答案存疑"记录点名，确认答案也发不出去，于是 published 是 2 不是 3。
# 这正是"按 id、字母序、插入顺序取第一条"那个高发错误，所以按**可达性**挑，
# 并且把决定可达性的那个属性（status）打出来。
CONFIRM_IDS=$(sql "SELECT question_id FROM questions
  WHERE exam_id='biochem-ch01' AND status <> '存疑' ORDER BY ord LIMIT 3;" \
  | jq -r '.[0].results[].question_id')
echo "     （挑中的三道：$(echo "$CONFIRM_IDS" | tr '\n' ' ')—— 都不是存疑，所以发得出去）"
check "挑到了三道" "$(echo "$CONFIRM_IDS" | grep -c .)" "3"
for qid in $CONFIRM_IDS; do
  exec_sql "UPDATE questions SET answer_state='已确认' WHERE question_id='$qid';"
done
PUB2=$(admj -X POST "$BASE/admin/bank/exams/biochem-ch01/publish")
check "确认过的三道进去了" "$(echo "$PUB2" | jq -r '.published')" "3"
check "其余的还是扣着" "$(echo "$PUB2" | jq -r '.heldNoAnswer')" "$((EXPECT_HELD_NO_ANSWER - 3))"
check "学员这时能抽到生化的题了" \
  "$(stu "$BASE/practice/scope?courseCode=biochem-main" | jq -r '.questionCount')" "3"

echo
echo "== 后台上传的内容组不会被种子清掉（N6b） =="
# 把一套英语真题临时标成"后台上传的"，再重新导入它自己的那个种子文件。
# 两件事要同时成立：
#   ① 种子的 DELETE 只清 origin='SEED'，所以它的题一道都不该少；
#   ② INSERT 会撞主键、整个文件导入失败——id 撞车该停下来让人看，不该悄悄合并。
# 不加 ① 的后果是"下一次部署把管理员录好的整章连同学生作答一起抹了"，
# 而 DELETE 删不到行不报错，日志里一片正常。
UP_EX=$(one "SELECT exam_id FROM exams WHERE course_code='13000' ORDER BY exam_id LIMIT 1;")
UP_BEFORE=$(one "SELECT COUNT(*) FROM questions WHERE exam_id='$UP_EX';")
check "挑中的这套真题确实有题（否则下面是空断言）" \
  "$([ "${UP_BEFORE:-0}" -ge 10 ] && echo 有 || echo 无)" "有"
check "现有内容组的来源都是种子" \
  "$(one "SELECT COUNT(*) FROM exams WHERE origin <> 'SEED';")" "0"
exec_sql "UPDATE exams SET origin='UPLOAD' WHERE exam_id='$UP_EX';"
UP_SEED=$(ls seed/*"$UP_EX".sql 2>/dev/null | head -1)
npx wrangler d1 execute "$D1_NAME" --local --file="$UP_SEED" >/dev/null 2>&1
check "种子重导时撞主键、整体失败" "$?" "1"
check "标成上传的内容组还在" "$(one "SELECT COUNT(*) FROM exams WHERE exam_id='$UP_EX';")" "1"
check "它的题一道都没少" "$(one "SELECT COUNT(*) FROM questions WHERE exam_id='$UP_EX';")" "$UP_BEFORE"
exec_sql "UPDATE exams SET origin='SEED' WHERE exam_id='$UP_EX';"
# 正面对照：护栏不能把正常的重导也挡死。红的时候要说得出为什么——
# 只报"期望 0 实际 1"的话，下一个人得自己把这一步重放一遍才知道是哪句 SQL 失败。
npx wrangler d1 execute "$D1_NAME" --local --file="$UP_SEED" >/tmp/n6-reimport.log 2>&1
REIMPORT_RC=$?
check "改回种子之后重导又能成功" "$REIMPORT_RC" "0"
[ "$REIMPORT_RC" = "0" ] || {
  echo "     （重导失败，报错如下）"
  grep -oE '"(error|message|cause)"[^,}]*' /tmp/n6-reimport.log | head -4 | sed 's/^/       /'
}

echo
echo "== 旧库模拟：新列补得上、回填对得上 =="
# 本地库每次都是新建的，天生带着这些列，不把列删掉就永远测不到补列脚本
# （同 n5-items.sh 里那段，起因见 docs/开发踩坑记录.md 第十一节）。
for spec in "exams order_key" "exams label" "exams meta" \
            "questions answer_state" "questions answer_source" \
            "exam_parsing_notes note_kind"; do
  set -- $spec
  npx wrangler d1 execute "$D1_NAME" --local --command "ALTER TABLE $1 DROP COLUMN $2;" >/dev/null 2>&1
done
check "旧库模拟成功（exams.order_key 没了）" "$(cols exams | grep -cw order_key)" "0"
check "旧库模拟成功（questions.answer_state 没了）" "$(cols questions | grep -cw answer_state)" "0"
# ① 反面：生化那一章没有年月，order_key 算不出来，补列脚本必须让部署失败，
#    而不是拿 year*100+month 算出个 0 填进去（0 是合法排序键，那一章会静默排到最前）。
bash "$ROOT_DIR/../scripts/ci/ensure-columns.sh" --local >/tmp/n6-ensure0.log 2>&1
check "算不出 order_key 时脚本退出码非 0" "$?" "1"
check "并且点名是哪一个内容组" "$(grep -c biochem-ch01 /tmp/n6-ensure0.log)" "1"
check "那一行确实留空，没有被填成 0" \
  "$(one "SELECT COALESCE(order_key, '空') FROM exams WHERE exam_id='biochem-ch01';")" "空"
check "有年月的那些行照样填上了" "$(one 'SELECT COUNT(*) FROM exams WHERE order_key IS NULL;')" "1"

# ② 正面：人工补上章节号之后再跑
exec_sql "UPDATE exams SET order_key = 1 WHERE exam_id='biochem-ch01';"
bash "$ROOT_DIR/../scripts/ci/ensure-columns.sh" --local >/tmp/n6-ensure.log 2>&1
RC=$?
check "补上章节号之后脚本通过" "$RC" "0"
check "第一趟就把 6 列都加上了（这一趟只剩回填）" "$(grep -c '^  ++ 给' /tmp/n6-ensure0.log)" "6"
# 只对有年月的行成立：生化那一章的 order_key 是上面人工补的章节号 1，
# 按 year*100+month 算出来是 0——回填故意不碰它（见 ensure-columns.sh 的注释）。
check "有年月的内容组都回填成 year*100+month" \
  "$(one "SELECT COUNT(*) FROM exams WHERE year > 0 AND month > 0 AND order_key <> year*100+month;")" "0"
check "没年月的那一章保住了人工补的章节号" \
  "$(one "SELECT order_key FROM exams WHERE exam_id='biochem-ch01';")" "1"
check "label 回填成 title" "$(one 'SELECT COUNT(*) FROM exams WHERE label <> title;')" "0"
check "answer_state 全部回填成已确认" \
  "$(one "SELECT COUNT(*) FROM questions WHERE answer_state <> '已确认';")" "0"
check "answer_source 全部回填成 OFFICIAL" \
  "$(one "SELECT COUNT(*) FROM questions WHERE answer_source <> 'OFFICIAL';")" "0"
check "note_kind 全部回填成解析存疑" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE note_kind <> '解析存疑';")" "0"
check "补完之后整套迁移还跑得过" \
  "$(MIGOK=1; for m in migrations/*.sql; do npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || MIGOK=0; done; echo $MIGOK)" "1"
check "再跑一次补列是空操作" \
  "$(bash "$ROOT_DIR/../scripts/ci/ensure-columns.sh" --local 2>&1 | grep -c '本次新增 0 列')" "1"

echo
echo "== 服务还活着 =="
# 中间任何一步把 workerd 弄崩了，后面的断言会以"实际 000"成片变红，
# 而真正的原因在 dev 日志里。这一条把它挑明。
check "跑完之后服务还在" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/health")" "200"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
