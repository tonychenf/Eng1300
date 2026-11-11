#!/usr/bin/env bash
# 改进阶段 2 第三期 F·考点整理的服务端（PRD 7.3）：列表、改名（不重名）、调上级（只能挂一级下、有下级的不能下挂）、
# 合并 A → B（题去重、掌握度相加、下级改挂、模板筛选改写、专项练习范围、连着合并、审计和合并记录），
# 以及合并之后：知识点种子再跑不会把 A 插回来、新题库文件写着 A 的名字挂到 B 上（种子那条路、后台导入那条路）。
#
# 用公共英语的考点（种子导进来）。学员掌握度是这里直接插的固定值，期望值按这些常数现算，不从被测接口读。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8763          # 端口表见 CLAUDE.md
BASE="http://127.0.0.1:$PORT/api"
WORK=$(mktemp -d)
PASS=0; FAIL=0
PE_DIR="$ROOT_DIR/../data/subjects/pubeng"

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

echo "== 准备：迁移、公共英语种子 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-ph2kp
SETUP_TOKEN=test-setup-ph2kp
ENCRYPTION_KEY=test-encryption-key-ph2kp
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "迁移 $m 失败"; exit 1; }
done
SEED="$WORK/seed"
SEED_SUBJECT_DIR="$PE_DIR" node ../scripts/build-seed-sql.mjs "$SEED" > "$WORK/seed.log" 2>&1 || { echo "种子生成失败："; cat "$WORK/seed.log"; exit 1; }
for f in "$SEED"/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$f" >/dev/null 2>&1 || { echo "导入 $f 失败"; exit 1; }
done
KP_SEED=$(ls "$SEED"/*knowledge-points*.sql | head -1)
[ -f "$KP_SEED" ] || { echo "种子里没有知识点文件"; exit 1; }

DEV_LOG=/tmp/ph2-kp-dev.log
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
ready=0
for i in $(seq 1 150); do curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1; done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-ph2kp' -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
mkuser() { curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d "{\"username\":\"$1\",\"subjects\":[]}" | jq -r '.initialPassword'; }
PW=$(mkuser KPS01)
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "$(jq -n --arg p "$PW" '{username:"KPS01",password:$p}')" | jq -r '.token')
mkuser KPS02 >/dev/null
U1=$(one "SELECT id FROM users WHERE username = 'KPS01';"); U2=$(one "SELECT id FROM users WHERE username = 'KPS02';")

code() { curl -s -o "$WORK/last.json" -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
A() { curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$@"; }
SID=$(one "SELECT subject_id FROM subjects WHERE code = 'pubeng';")
COURSE=$(one "SELECT course_code FROM courses WHERE subject_id = $SID ORDER BY course_code LIMIT 1;")
KP="$BASE/admin/subjects/$SID/knowledge-points"
patch_kp() { code -X PATCH "$KP/$1" -H "Authorization: Bearer $ADMIN" -d "$2"; }
merge() { code -X POST "$KP/merge" -H "Authorization: Bearer $ADMIN" -d "{\"from\":\"$1\",\"into\":\"$2\"}"; }
qs_of() { one "SELECT COUNT(*) FROM question_knowledge_points WHERE tag_id = '$1';"; }
parent_of() { one "SELECT IFNULL(parent_tag_id, '无') FROM knowledge_points WHERE tag_id = '$1';"; }

echo
echo "== 权限 =="
for spec in "GET $KP" "PATCH $KP/pe-voc-01" "POST $KP/merge"; do
  set -- $spec
  check "学员令牌调 $1 ${2#$BASE} → 403" "$(code -X "$1" "$2" -H "Authorization: Bearer $STU" -d '{}')" "403"
done
check "不存在的学科 → 404" "$(code "$BASE/admin/subjects/9999/knowledge-points" -H "Authorization: Bearer $ADMIN")" "404"
check "别的学科的考点 → 404" "$(code -X PATCH "$KP/kp-not-here" -H "Authorization: Bearer $ADMIN" -d '{"name":"x"}')" "404"

echo
echo "== 列表 =="
A "$KP" > "$WORK/list.json"
check "考点数和文件一致" "$(jq '.knowledgePoints | length' "$WORK/list.json")" "$(jq '.points | length' "$PE_DIR/knowledge-points.json")"
check "一级考点数和文件一致" "$(jq '[.knowledgePoints[] | select(.parentTagId == null)] | length' "$WORK/list.json")" "$(jq '[.points[] | select(.parentTagId == null)] | length' "$PE_DIR/knowledge-points.json")"
check "挂的题数和库里一致（词义辨析）" "$(jq -r '.knowledgePoints[] | select(.tagId == "pe-voc-01") | .questions' "$WORK/list.json")" "$(qs_of pe-voc-01)"
check "下级个数（词汇下面 5 个，和文件一致）" "$(jq -r '.knowledgePoints[] | select(.tagId == "pe-voc") | .children' "$WORK/list.json")" "$(jq '[.points[] | select(.parentTagId == "pe-voc")] | length' "$PE_DIR/knowledge-points.json")"

echo
echo "== 改名 =="
check "空名字 → 400" "$(patch_kp pe-voc-05 '{"name":"  "}')" "400"
check "超过 40 个字 → 400" "$(patch_kp pe-voc-05 "$(jq -nc --arg n "$(printf '字%.0s' $(seq 41))" '{name:$n}')")" "400"
check "和同学科别的考点重名 → 409，说出用合并" "$(patch_kp pe-voc-05 '{"name":"词义辨析"}')/$(jq -r '.message | contains("合并")' "$WORK/last.json")" "409/true"
check "改名 → 200，库里改了" "$(patch_kp pe-voc-05 '{"name":"拼写"}')/$(one "SELECT name FROM knowledge_points WHERE tag_id = 'pe-voc-05';")" "200/拼写"
check "审计记下改前改后" "$(one "SELECT json_extract(before_json, '\$.name') || '→' || json_extract(after_json, '\$.name') FROM admin_audit WHERE action = 'kp.update' AND target = 'pe-voc-05';")" "单词拼写→拼写"

echo
echo "== 调上级 =="
check "挂到自己下面 → 422" "$(patch_kp pe-gra '{"parentTagId":"pe-gra"}')" "422"
check "挂到二级考点下（会成三级）→ 422" "$(patch_kp pe-voc-05 '{"parentTagId":"pe-voc-01"}')" "422"
check "自己有下级、要挂到别人下 → 422 has_children" "$(patch_kp pe-gra '{"parentTagId":"pe-voc"}')/$(jq -r '.error' "$WORK/last.json")" "422/has_children"
check "别的学科的上级 → 422" "$(patch_kp pe-voc-05 '{"parentTagId":"kp-not-here"}')" "422"
check "挂到另一个一级下 → 200" "$(patch_kp pe-voc-05 '{"parentTagId":"pe-gra"}')/$(parent_of pe-voc-05)" "200/pe-gra"
check "改成一级（上级为空）→ 200" "$(patch_kp pe-voc-05 '{"parentTagId":null}')/$(parent_of pe-voc-05)" "200/无"
patch_kp pe-voc-05 '{"parentTagId":"pe-voc"}' >/dev/null

echo
echo "== 合并 A → B：短语与固定搭配（pe-voc-03）→ 词义辨析（pe-voc-01）=="
# 造一道两边都挂着的题（去重要看得见），记下合并前两边的题
DUP_Q=$(one "SELECT question_id FROM question_knowledge_points WHERE tag_id = 'pe-voc-03' ORDER BY question_id LIMIT 1;")
exec_sql "INSERT OR IGNORE INTO question_knowledge_points (question_id, tag_id) VALUES ('$DUP_Q', 'pe-voc-01');"
WANT_Q=$(one "SELECT COUNT(DISTINCT question_id) FROM question_knowledge_points WHERE tag_id IN ('pe-voc-03', 'pe-voc-01');")
NA=$(qs_of pe-voc-03)
echo "  （合并前：A $NA 道、B $(qs_of pe-voc-01) 道，有 1 道两边都挂；合并后应是 $WANT_Q 道）"
# 掌握度：学员 1 两边都有（A 那一行练得更晚），学员 2 只有 A
exec_sql "INSERT INTO user_knowledge_mastery (user_id, course_code, tag_id, correct_count, wrong_count, consecutive_correct, last_result, last_practiced_at) VALUES
  ($U1, '$COURSE', 'pe-voc-03', 3, 2, 1, 'correct', '2026-11-10 10:00:00'),
  ($U1, '$COURSE', 'pe-voc-01', 5, 4, 0, 'wrong',   '2026-11-01 10:00:00'),
  ($U2, '$COURSE', 'pe-voc-03', 7, 1, 4, 'correct', '2026-11-05 09:00:00');"
# 组卷模板：一项只写 A（要改成 B）、一项 A 和 B 都写（要去重）
exec_sql "UPDATE exam_template_items SET filter = '{\"knowledgePoints\":[\"pe-voc-03\"]}' WHERE course_code = '$COURSE' AND ord = (SELECT MIN(ord) FROM exam_template_items WHERE course_code = '$COURSE');"
exec_sql "UPDATE exam_template_items SET filter = '{\"knowledgePoints\":[\"pe-voc-03\",\"pe-voc-01\"]}' WHERE course_code = '$COURSE' AND ord = (SELECT MAX(ord) FROM exam_template_items WHERE course_code = '$COURSE');"
TV_BEFORE=$(one "SELECT template_version FROM courses WHERE course_code = '$COURSE';")
# 进行中的单考点专项（范围是 A）
exec_sql "INSERT INTO attempts (attempt_id, user_id, course_code, mode, status, practice_stage, scope_knowledge_point, time_limit_minutes) VALUES ('kp-test-att', $U1, '$COURSE', 'PRACTICE', '进行中', '单考点专项', 'pe-voc-03', 0);"

check "合并进自己 → 422" "$(merge pe-voc-03 pe-voc-03)" "422"
check "不存在的 → 404" "$(merge pe-voc-03 kp-nope)" "404"
check "合并 → 200，转过去 $NA 道题、2 条学员记录" "$(merge pe-voc-03 pe-voc-01)/$(jq -r '"\(.moved.questions)/\(.moved.mastery)"' "$WORK/last.json")" "200/$NA/2"
check "A 删掉了" "$(one "SELECT COUNT(*) FROM knowledge_points WHERE tag_id = 'pe-voc-03';")" "0"
check "B 挂的题 = 两边的并集（$WANT_Q，两边都挂的那道不重复）" "$(qs_of pe-voc-01)" "$WANT_Q"
check "没有题还挂着 A" "$(qs_of pe-voc-03)" "0"
check "学员 1：次数相加（对 8、错 6），连对和上次结果取 A（练得更晚）、时间取较晚" \
  "$(one "SELECT correct_count || '/' || wrong_count || '/' || consecutive_correct || '/' || last_result || '/' || last_practiced_at FROM user_knowledge_mastery WHERE user_id = $U1 AND tag_id = 'pe-voc-01';")" \
  "8/6/1/correct/2026-11-10 10:00:00"
check "学员 2：只有 A 的整行转给 B" \
  "$(one "SELECT correct_count || '/' || wrong_count || '/' || consecutive_correct || '/' || last_practiced_at FROM user_knowledge_mastery WHERE user_id = $U2 AND tag_id = 'pe-voc-01';")" "7/1/4/2026-11-05 09:00:00"
check "掌握度表里不剩 A" "$(one "SELECT COUNT(*) FROM user_knowledge_mastery WHERE tag_id = 'pe-voc-03';")" "0"
check "模板：只写 A 的改成 B；A、B 都写的去重成一个 B" \
  "$(one "SELECT group_concat(filter, ' | ') FROM (SELECT filter FROM exam_template_items WHERE course_code = '$COURSE' AND filter LIKE '%knowledgePoints%' ORDER BY ord);")" \
  '{"knowledgePoints":["pe-voc-01"]} | {"knowledgePoints":["pe-voc-01"]}'
check "模板版本号加一（开着模板页的人再保存会被告知）" "$(one "SELECT template_version FROM courses WHERE course_code = '$COURSE';")" "$((TV_BEFORE + 1))"
check "进行中的专项练习改到 B" "$(one "SELECT scope_knowledge_point FROM attempts WHERE attempt_id = 'kp-test-att';")" "pe-voc-01"
check "合并记录：A → B，快照里有 A 的 $NA 道题、2 条掌握度" \
  "$(one "SELECT into_tag_id || '/' || from_name || '/' || json_array_length(snapshot_json, '\$.questions') || '/' || json_array_length(snapshot_json, '\$.mastery') FROM knowledge_point_merges WHERE from_tag_id = 'pe-voc-03';")" \
  "pe-voc-01/短语与固定搭配/$NA/2"
check "审计记下一笔合并" "$(one "SELECT json_extract(after_json, '\$.into') FROM admin_audit WHERE action = 'kp.merge' AND target = 'pe-voc-03';")" "pe-voc-01"

echo
echo "== 合并之后：种子、后台导入都挂到 B 上 =="
npx wrangler d1 execute "$D1_NAME" --local --file="$KP_SEED" >/dev/null 2>&1 || echo "    （知识点种子再跑失败）"
check "知识点种子再跑一遍，A 不会插回来" "$(one "SELECT COUNT(*) FROM knowledge_points WHERE tag_id = 'pe-voc-03' OR (subject_id = $SID AND name = '短语与固定搭配');")" "0"
# 从种子里挑一句"给题挂 A"的原句，换成一道还没挂 B 的题再执行：应当挂到 B
LINE=$(grep -h "INSERT OR IGNORE INTO question_knowledge_points" "$SEED"/*.sql | grep -m1 "短语与固定搭配")
OTHER_Q=$(one "SELECT question_id FROM questions WHERE course_code = '$COURSE' AND question_id NOT IN (SELECT question_id FROM question_knowledge_points WHERE tag_id = 'pe-voc-01') ORDER BY question_id LIMIT 1;")
ORIG_Q=$(printf '%s' "$LINE" | sed -E "s/.*VALUES \('([^']+)'.*/\1/")
printf '%s\n' "${LINE/\'$ORIG_Q\'/\'$OTHER_Q\'}" > "$WORK/attach.sql"
check "（前提）挑到的那句写的是 A 的名字和编号" "$(grep -c "短语与固定搭配" "$WORK/attach.sql")/$(grep -c "pe-voc-03" "$WORK/attach.sql")" "1/1"
npx wrangler d1 execute "$D1_NAME" --local --file="$WORK/attach.sql" >/dev/null 2>&1 && R=ok || R=fail
check "种子里写着 A 的那句：执行成功、挂到了 B" "$R/$(one "SELECT GROUP_CONCAT(tag_id) FROM question_knowledge_points WHERE question_id = '$OTHER_Q' AND tag_id IN ('pe-voc-01', 'pe-voc-03');")" "ok/pe-voc-01"
# 后台导入题库文件（第一期 json-direct）：题目考点写 A 的名字
jq '.sections = [.sections[0] | .questions = (.questions[:2] | map(.knowledgePoints = ["词汇/短语与固定搭配"]))]' "$PE_DIR/groups/pubeng-mc1.json" > "$WORK/kp-up.json"
check "后台导入一个写着 A 名字的文件 → 200" \
  "$(curl -s -o "$WORK/up.json" -w '%{http_code}' -X POST "$BASE/admin/bank/import?subjectCode=pubeng&filename=kp-up.json" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/octet-stream' --data-binary @"$WORK/kp-up.json")" "200"
G=$(jq -r '.groupId' "$WORK/up.json")
check "导进来的 2 道挂到 B，没有按旧名字新建考点" \
  "$(one "SELECT COUNT(*) FROM question_knowledge_points x JOIN questions q ON q.question_id = x.question_id WHERE q.exam_id = '$G' AND x.tag_id = 'pe-voc-01';")/$(one "SELECT COUNT(*) FROM knowledge_points WHERE subject_id = $SID AND name = '短语与固定搭配';")" "2/0"

echo
echo "== 合并一级考点：下级改挂 =="
WANT_KIDS=$(( $(one "SELECT COUNT(*) FROM knowledge_points WHERE parent_tag_id IN ('pe-gra', 'pe-rd');") ))
check "语法（pe-gra）→ 阅读（pe-rd）→ 200，转过去 1 个下级" "$(merge pe-gra pe-rd)/$(jq -r '.moved.children' "$WORK/last.json")" "200/1"
check "语法结构改挂阅读；阅读下面 $WANT_KIDS 个" "$(parent_of pe-gra-01)/$(one "SELECT COUNT(*) FROM knowledge_points WHERE parent_tag_id = 'pe-rd';")" "pe-rd/$WANT_KIDS"
check "有下级的合并进二级考点（会成三级）→ 422 would_nest" "$(merge pe-txt pe-voc-02)/$(jq -r '.error' "$WORK/last.json")" "422/would_nest"
check "  一行都没动" "$(one "SELECT COUNT(*) FROM knowledge_points WHERE tag_id = 'pe-txt';")/$(one "SELECT COUNT(*) FROM knowledge_points WHERE parent_tag_id = 'pe-txt';")" "1/4"
check "合并进自己的下级：翻译（pe-tr）→ 词组英译汉（pe-tr-01）→ 200" "$(merge pe-tr pe-tr-01)" "200"
check "  词组英译汉接替成一级，翻译原来的另两个下级挂到它下面" \
  "$(parent_of pe-tr-01)/$(parent_of pe-tr-02)/$(parent_of pe-tr-03)" "无/pe-tr-01/pe-tr-01"

echo
echo "== 连着合并：B 又并进 C，以前并进 B 的记录跟着指到 C =="
check "词义辨析（pe-voc-01）→ 词形与派生（pe-voc-02）→ 200" "$(merge pe-voc-01 pe-voc-02)" "200"
check "A（pe-voc-03）的合并记录改指 pe-voc-02" "$(one "SELECT into_tag_id FROM knowledge_point_merges WHERE from_tag_id = 'pe-voc-03';")" "pe-voc-02"
check "合并记录都指向还在的考点" "$(one "SELECT COUNT(*) FROM knowledge_point_merges WHERE into_tag_id NOT IN (SELECT tag_id FROM knowledge_points);")" "0"
check "学员 1 的记录跟到 C" "$(one "SELECT correct_count FROM user_knowledge_mastery WHERE user_id = $U1 AND tag_id = 'pe-voc-02';")" "8"
check "列表里没有合并掉的" "$(A "$KP" | jq -r '[.knowledgePoints[].tagId | select(. == "pe-voc-01" or . == "pe-voc-03" or . == "pe-gra" or . == "pe-tr")] | length')" "0"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
exit $([ "$FAIL" = 0 ] && echo 0 || echo 1)
