#!/usr/bin/env bash
# 改进阶段 2 第一期·学员侧（2026-11-08）：练习里按采分点当场 AI 批（P1-G1）、AI 记账与每月上限（C1–C3）、
# 模考各部分名称和"可能重复"提示存在作答记录里（X5、G2）。需求见 docs/改进阶段2-PRD.md。
#
# 替身只能证明协议和降级路径（CLAUDE.md 三"接外部依赖时"）：批得准不准要靠线上实测。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8770          # 端口表见 CLAUDE.md
STUB_PORT=8886
BASE="http://127.0.0.1:$PORT/api"
STUB="http://127.0.0.1:$STUB_PORT"
TPL_JSON="$ROOT_DIR/../data/subjects/pubeng/exam-template.json"
WORK=$(mktemp -d)
PASS=0; FAIL=0
PRICE_IN=2; PRICE_OUT=8      # 元 / 百万 tokens；替身每次回 100 / 50 tokens

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

echo "== 准备本地数据库：公共英语全部导入、翻译题采分点当作已确认、全部发布 =="
rm -rf .wrangler
# 练习批改的时限调到 1.5 秒：替身的【超时】要 5 秒才回，等满默认的 20 秒太慢
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-ph2ai
SETUP_TOKEN=test-setup-ph2ai
ENCRYPTION_KEY=test-encryption-key-ph2ai
PRACTICE_AI_TIMEOUT_MS=1500
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "迁移 $m 失败"; exit 1; }
done
SEED_SUBJECT_DIR="$ROOT_DIR/../data/subjects/pubeng" node ../scripts/build-seed-sql.mjs "$WORK/seed" > "$WORK/seed.log" 2>&1 \
  || { echo "公共英语种子生成失败："; cat "$WORK/seed.log"; exit 1; }
for f in "$WORK"/seed/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$f" >/dev/null 2>&1 || { echo "导入 $f 失败"; exit 1; }
done
exec_sql "UPDATE questions SET answer_state = '已确认', answer_reviewed_by = 'ph2-ai' WHERE course_code = 'pubeng-main';
          UPDATE system_settings SET value = '1000' WHERE key IN ('limit.exam_per_minute', 'limit.exam_per_day');"
npx wrangler d1 execute "$D1_NAME" --local --file=test/fixtures/publish-all.sql >/dev/null 2>&1
PE_ID=$(one "SELECT subject_id FROM subjects WHERE code = 'pubeng';")

echo "== 启动 AI 替身与服务 =="
node test/ai-stub.mjs "$STUB_PORT" > /tmp/ph2-practice-ai-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/ph2-practice-ai-dev.log
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
ready=0
for i in $(seq 1 150); do curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1; done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-ph2ai' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
check "AI 配置能存单价" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$STUB/v1" --argjson pi $PRICE_IN --argjson po $PRICE_OUT '{baseUrl:$u,apiKey:"stub-key",model:"stub-model",protocol:"openai",priceInPerM:$pi,priceOutPerM:$po}')")" "200"
check "单价读得回来" "$(curl -s "$BASE/admin/ai/settings" -H "Authorization: Bearer $ADMIN" | jq -r '"\(.settings.TUTORING.priceInPerM)/\(.settings.TUTORING.priceOutPerM)"')" "$PRICE_IN/$PRICE_OUT"
check "单价是负数 → 400" "$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"priceInPerM":-1}')" "400"

PW=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"username":"PAI01","subjects":["pubeng"]}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$PW" '{username:"PAI01",password:$p}')" | jq -r '.token')
[ -n "$STU" ] && [ "$STU" != null ] || { echo "学员登录失败"; exit 1; }
STU_ID=$(one "SELECT id FROM users WHERE username = 'PAI01';")

post() { curl -s -X POST "$BASE$1" -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d "$2"; }
stub_calls() { curl -s "$STUB/stats" | jq -r '.pointsCalls'; }
used() { one "SELECT COUNT(*) FROM ai_usage_logs WHERE user_id = $STU_ID AND feature = 'practice_point_grade';"; }
# 开一个练习、把指定的题放进去（就是 /next 选中它时做的那件事），好让同一道题在新练习里再答一次
practice_with() {
  local pid
  pid=$(post /practice/start "$(jq -nc --arg s "$1" '{courseCode:"pubeng-main",sectionTypes:[$s]}')" | jq -r '.attemptId')
  exec_sql "INSERT INTO attempt_questions (attempt_id, ord, question_id, section_id, section_ord, score_per_question)
            SELECT '$pid', 1, question_id, section_id, 0, 0 FROM questions WHERE question_id = '$2';"
  echo "$pid"
}
answer() { post "/practice/$1/answer" "$(jq -nc --arg q "$2" --arg a "$3" '{questionId:$q,answer:$a}')"; }

# 挑题：一道 3 个采分点的句子翻译、一道 1 个采分点的词组翻译（按采分点个数挑，打印出来）
SENT=$(one "SELECT q.question_id FROM questions q WHERE q.course_code = 'pubeng-main' AND q.question_type = 'sentence_translate'
              AND (SELECT COUNT(*) FROM question_items i WHERE i.question_id = q.question_id) = 3 ORDER BY q.question_id LIMIT 1;")
PHR=$(one "SELECT q.question_id FROM questions q WHERE q.course_code = 'pubeng-main' AND q.question_type = 'phrase_translate'
             AND (SELECT COUNT(*) FROM question_items i WHERE i.question_id = q.question_id) = 1 ORDER BY q.question_id LIMIT 1;")
SENT2=$(one "SELECT q.question_id FROM questions q WHERE q.course_code = 'pubeng-main' AND q.question_type = 'sentence_translate'
               AND q.question_id <> '$SENT' ORDER BY q.question_id LIMIT 1;")
echo "  （挑的题：句子翻译 $SENT（3 个采分点），词组翻译 $PHR（1 个采分点），另一道句子翻译 $SENT2）"
[ -n "$SENT" ] && [ -n "$PHR" ] && [ -n "$SENT2" ] || { echo "挑不到题"; exit 1; }

echo
echo "== G1 全对：当场批、记账 =="
curl -s "$STUB/stats?reset=1" >/dev/null
P1=$(practice_with 句子翻译 "$SENT")
R=$(answer "$P1" "$SENT" "【全对】This is my translation.")
check "批了（aiGraded）、算答对、得分率 1" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.isCorrect)/\(.scoreRate)"')" "true/1/1"
check "每个采分点带着替身给的理由" "$(echo "$R" | jq -r '[.itemResults[].items[].reason] | map(select(test("^替身"))) | length')" "3"
check "不再是\"练习不判分\"（selfCheck false）" "$(echo "$R" | jq -r '.selfCheck')" "false"
check "替身被调了 1 次" "$(stub_calls)" "1"
check "用量记在 practice_point_grade、带着学员和学科" \
  "$(one "SELECT feature || '|' || user_id || '|' || subject_id FROM ai_usage_logs WHERE feature = 'practice_point_grade' ORDER BY id DESC LIMIT 1;")" \
  "practice_point_grade|$STU_ID|$PE_ID"
WANT_COST=$(awk -v i=$PRICE_IN -v o=$PRICE_OUT 'BEGIN { printf "%.4f", (100*i + 50*o) / 1e6 }')
check "花费按替身记下的 tokens × 单价现算：$WANT_COST 元" \
  "$(one "SELECT printf('%.4f', cost_yuan) FROM ai_usage_logs WHERE feature = 'practice_point_grade' ORDER BY id DESC LIMIT 1;")" "$WANT_COST"
check "当月累计也加上了" "$(one "SELECT printf('%.4f', cost_yuan) || '/' || calls FROM ai_spend_monthly;")" "$WANT_COST/1"
check "作答记录标了 ai_judged、存了逐点结果" \
  "$(one "SELECT ai_judged || '/' || (item_results IS NOT NULL) || '/' || is_correct FROM answer_records WHERE attempt_id = '$P1' AND question_id = '$SENT';")" "1/1/1"

echo
echo "== G1 部分答到：门槛 0.6 =="
P2=$(practice_with 句子翻译 "$SENT")
R=$(answer "$P2" "$SENT" "【单号】我的译文")
# 3 个采分点答到 1、3 → 2/3 ≥ 0.6
check "答到 2/3：部分得分、按 0.6 的门槛算答对" "$(echo "$R" | jq -r '"\(.scoreRate * 1000 | floor)/\(.isCorrect)"')" "666/1"
P3=$(practice_with 词组翻译 "$PHR")
R=$(answer "$P3" "$PHR" "【全错】乱写的")
check "一个都没答到：算答错" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.isCorrect)/\(.scoreRate)"')" "true/0/0"
check "答错的进了错题本" "$(one "SELECT COUNT(*) FROM wrong_items WHERE user_id = $STU_ID AND question_id = '$PHR';")" "1"
check "答对的没进错题本" "$(one "SELECT COUNT(*) FROM wrong_items WHERE user_id = $STU_ID AND question_id = '$SENT';")" "0"

echo
echo "== G1 缓存：一字不差的作答不重复批 =="
BEFORE=$(stub_calls); UB=$(used)
P4=$(practice_with 句子翻译 "$SENT")
R=$(answer "$P4" "$SENT" "【全对】This is my translation.")
check "同一作答在新练习里再交：结果一样" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.isCorrect)/\(.scoreRate)"')" "true/1/1"
check "没有再调替身" "$(stub_calls)" "$BEFORE"
check "也不算今天的次数" "$(used)" "$UB"
# 后台改了采分点：缓存键变了，同一作答要重新批
exec_sql "UPDATE question_items SET answer = answer || '（改过）' WHERE question_id = '$SENT' AND item_ord = 1;"
P5=$(practice_with 句子翻译 "$SENT")
answer "$P5" "$SENT" "【全对】This is my translation." >/dev/null
check "采分点改过之后同一作答重新批（替身多调了 1 次）" "$(stub_calls)" "$((BEFORE + 1))"
exec_sql "UPDATE question_items SET answer = replace(answer, '（改过）', '') WHERE question_id = '$SENT' AND item_ord = 1;"

echo
echo "== G1 没批出来：不显示 0 分、可以重试、失败也算次数 =="
UB=$(used)
P6=$(practice_with 句子翻译 "$SENT2")
R=$(answer "$P6" "$SENT2" "【照抄】我的译文")
check "替身照抄示例：没批出来，回自评 + 原因" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.selfCheck)/\(.isCorrect)/\(.aiError.code)"')" "false/true/null/ai_bad_shape"
check "作答存下了，is_correct 留空（不是 0 分）" \
  "$(one "SELECT (user_answer IS NOT NULL) || '/' || COALESCE(is_correct, 'NULL') FROM answer_records WHERE attempt_id = '$P6' AND question_id = '$SENT2';")" "1/NULL"
check "失败的那次也算今天的次数" "$(( $(used) > UB ))" "1"
R=$(answer "$P6" "$SENT2" "【全对】我的译文")
check "带新作答再交一次就是重试：这次批出来了" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.isCorrect)"')" "true/1"
check "批出来之后再交 → 409 已经答过" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/practice/$P6/answer" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d "$(jq -nc --arg q "$SENT2" '{questionId:$q,answer:"【全对】再来"}')")" "409"

T0=$(date +%s%N)
P7=$(practice_with 句子翻译 "$SENT2")
R=$(answer "$P7" "$SENT2" "【超时】我的译文")
MS=$(( ($(date +%s%N) - T0) / 1000000 ))
check "替身 5 秒才回：到时限中止，原因是 ai_timeout" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.aiError.code)"')" "false/ai_timeout"
check "没有傻等替身那 5 秒（实际 ${MS} 毫秒）" "$([ "$MS" -lt 4900 ] && echo 是 || echo 否)" "是"
check "超时记进了用量日志" "$(one "SELECT COUNT(*) FROM ai_usage_logs WHERE user_id = $STU_ID AND success = 0 AND error_message LIKE '超时%';")" "1"

BEFORE=$(stub_calls)
P8=$(practice_with 句子翻译 "$SENT2")
R=$(answer "$P8" "$SENT2" "   ")
check "一个字没写：0 分、不调 AI" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.scoreRate)"')/$(stub_calls)" "true/0/$BEFORE"

echo
echo "== G1 每人每天上限 =="
N=$(used)
exec_sql "UPDATE system_settings SET value = '$N' WHERE key = 'limit.practice_ai_per_day';"
BEFORE=$(stub_calls)
P9=$(practice_with 句子翻译 "$SENT2")
R=$(answer "$P9" "$SENT2" "【全对】新的一份译文")
check "到了上限（今天已用 $N 次）：不调 AI、提示今天用完" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.aiError.code)"')/$(stub_calls)" "false/daily_limit/$BEFORE"
check "提示是给人看的话" "$(echo "$R" | jq -r '.aiError.message | test("今天的 AI 批改用完了")')" "true"
check "缓存里有的照样给（命中缓存不算次数）" "$(answer "$(practice_with 句子翻译 "$SENT")" "$SENT" "【全对】This is my translation." | jq -r '.aiGraded')" "true"
exec_sql "UPDATE system_settings SET value = '100' WHERE key = 'limit.practice_ai_per_day';"

echo
echo "== C3 每月上限：批改不停，只停错题分析 =="
curl -s -o /dev/null -X PUT "$BASE/admin/ai/budget" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"yuan":0.0001}'
check "（前提）本月已经花过上限" "$(curl -s "$BASE/admin/ai/budget" -H "Authorization: Bearer $ADMIN" | jq -r '.over')" "true"
P10=$(practice_with 句子翻译 "$SENT2")
check "到了上限，练习批改照常" "$(answer "$P10" "$SENT2" "【全对】又一份译文" | jq -r '.aiGraded')" "true"
WID=$(one "SELECT id FROM wrong_items WHERE user_id = $STU_ID AND question_id = '$PHR';")
check "错题分析暂停 → 409 budget_paused" "$(curl -s -o "$WORK/wa.json" -w '%{http_code}' -X POST "$BASE/wrongbook/$WID/analyze" -H "Authorization: Bearer $STU")/$(jq -r '.error' "$WORK/wa.json")" "409/budget_paused"
curl -s -o /dev/null -X PUT "$BASE/admin/ai/budget" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"yuan":null}'
check "去掉上限后错题分析恢复" "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/wrongbook/$WID/analyze" -H "Authorization: Bearer $STU")" "200"
SPEND=$(curl -s "$BASE/admin/ai/spend" -H "Authorization: Bearer $ADMIN")
check "花费页按功能分得出练习批改" "$(echo "$SPEND" | jq -r '[.byFeature[] | select(.feature == "practice_point_grade")] | length')" "1"
check "花费页的练习批改次数 = 用量日志里的次数" "$(echo "$SPEND" | jq -r '.byFeature[] | select(.feature == "practice_point_grade") | .calls')" "$(used)"

echo
echo "== 学科开关关掉：照旧\"练习不判分\" =="
curl -s -o /dev/null -X PUT "$BASE/admin/subjects/$PE_ID/settings/practice-ai" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"enabled":false}'
BEFORE=$(stub_calls)
R=$(answer "$(practice_with 句子翻译 "$SENT2")" "$SENT2" "【全对】关了开关之后")
check "开关关了：不批、自评、不调 AI" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.selfCheck)/\(.aiError)"')/$(stub_calls)" "false/true/null/$BEFORE"
curl -s -o /dev/null -X PUT "$BASE/admin/subjects/$PE_ID/settings/practice-ai" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"enabled":true}'
SC=$(one "SELECT question_id FROM questions WHERE course_code = 'pubeng-main' AND question_type = 'single_choice' ORDER BY question_id LIMIT 1;")
BEFORE=$(stub_calls)
R=$(answer "$(practice_with 选择填空 "$SC")" "$SC" "$(one "SELECT answer FROM questions WHERE question_id = '$SC';")")
check "有标准答案的题按标准答案判，不调 AI" "$(echo "$R" | jq -r '"\(.aiGraded)/\(.isCorrect)"')/$(stub_calls)" "false/1/$BEFORE"

echo
echo "== X5、G2 模考：部分名称和提示存在作答记录里 =="
AID=$(post /exams/generate '{"courseCode":"pubeng-main"}' | jq -r '.attemptId')
check "组卷成功" "$([ -n "$AID" ] && [ "$AID" != null ] && echo 是 || echo 否)" "是"
check "作答记录存了每个部分的名称（和模板一致）" \
  "$(one "SELECT section_meta FROM attempts WHERE attempt_id = '$AID';" | jq -c '[.[].label]')" "$(jq -c '[.items | sort_by(.ord)[].label]' "$TPL_JSON")"
# 期望的提示从库里现算：筛选条件相同的几项，要用掉的份数加起来 ≥ 候选数 → 有提示
WANT_NOTES=""
for row in $(jq -c '.items | sort_by(.ord)[] | {filter, pickUnit, questionCount}' "$TPL_JSON"); do
  key=$(echo "$row" | jq -c '{filter, pickUnit}')
  need=$(jq -c --argjson k "$key" '[.items[] | select({filter, pickUnit} == $k) | if .pickUnit == "SECTION" then 1 else .questionCount end] | add' "$TPL_JSON")
  pu=$(echo "$row" | jq -r '.pickUnit')
  if [ "$pu" = SECTION ]; then
    st=$(echo "$row" | jq -r '.filter.sectionTypes[0]'); qc=$(echo "$row" | jq -r '.questionCount')
    avail=$(one "SELECT COUNT(*) FROM (SELECT s.section_id FROM sections s JOIN questions q ON q.section_id = s.section_id
                  WHERE q.course_code = 'pubeng-main' AND q.status = '已发布' AND s.type = '$st' GROUP BY s.section_id HAVING COUNT(*) = $qc);")
  else
    if [ "$(echo "$row" | jq -r '.filter.questionTypes != null')" = true ]; then
      cond="q.question_type = '$(echo "$row" | jq -r '.filter.questionTypes[0]')'"
    else
      cond="q.section_type = '$(echo "$row" | jq -r '.filter.sectionTypes[0]')'"
    fi
    avail=$(one "SELECT COUNT(*) FROM questions q JOIN sections s ON s.section_id = q.section_id
                  WHERE q.course_code = 'pubeng-main' AND q.status = '已发布' AND $cond AND (s.passage_text IS NULL OR s.passage_text = '');")
  fi
  WANT_NOTES="$WANT_NOTES$([ "$need" -ge "$avail" ] && echo 1 || echo 0)"
done
check "\"可能与上次相同\"的提示（按候选数现算：$WANT_NOTES）" \
  "$(one "SELECT section_meta FROM attempts WHERE attempt_id = '$AID';" | jq -r '[.[] | if .note then "1" else "0" end] | join("")')" "$WANT_NOTES"
check "（前提）至少有一项有提示、一项没有，上面那条才分得出对错" "$([[ "$WANT_NOTES" == *1* && "$WANT_NOTES" == *0* ]] && echo 是 || echo 否)" "是"
ATT=$(curl -s "$BASE/attempts/$AID" -H "Authorization: Bearer $STU")
check "作答页的部分名称用模板标签：两篇阅读分得开" \
  "$(echo "$ATT" | jq -r '[.sections[].sectionType] | (index("阅读理解（一）") != null and index("阅读理解（二）") != null)')" "true"
check "作答页带着提示" "$(echo "$ATT" | jq -r '[.sections[] | select(.sectionNote)] | length')" "$(echo -n "${WANT_NOTES//0/}" | wc -c)"
# 改模板的标签之后，旧卷的部分名不变
exec_sql "UPDATE exam_template_items SET label = '阅读（改名）' WHERE course_code = 'pubeng-main' AND label = '阅读理解（一）';"
check "改了模板标签，旧卷的部分名不变" \
  "$(curl -s "$BASE/attempts/$AID" -H "Authorization: Bearer $STU" | jq -r '[.sections[].sectionType] | index("阅读理解（一）") != null')" "true"
exec_sql "UPDATE exam_template_items SET label = '阅读理解（一）' WHERE course_code = 'pubeng-main' AND label = '阅读（改名）';"
post "/attempts/$AID/submit" '{}' >/dev/null
check "交卷后的各部分得分也用模板标签" \
  "$(one "SELECT section_scores FROM attempts WHERE attempt_id = '$AID';" | jq -r '[.[].sectionType] | index("阅读理解（二）") != null')" "true"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
exit $([ "$FAIL" = 0 ] && echo 0 || echo 1)
