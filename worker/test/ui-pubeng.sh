#!/usr/bin/env bash
# 公共英语学员端的浏览器检查（2026-11-07）：每种题型在练习里打开、作答一遍，模考作答、交卷、看报告，三种宽度。
#
# 为什么要有：CLAUDE.md 四之二"加一个学科，要让它的每种题型都在浏览器里被打开过一次"。公共英语（迁移 0018）
# 上线时漏了这一步——拼写单词、三种翻译、带 15 个选项的段落填空，学员那边长什么样没人看过。
# 服务端套件只证明判得了分、组得出卷，证明不了好用（生化名词解释服务端全绿、浏览器白屏，就是这么来的）。
#
# 数据都在这里准备好再交给浏览器（同 ui-bio-exam.sh 的理由）：每道题该填什么按题干现查，不让用例自己猜。
set -uo pipefail
cd "$(dirname "$0")/.."

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8772          # 端口表见 CLAUDE.md
STUB_PORT=8887
BASE="http://127.0.0.1:$PORT/api"
TPL_JSON="$(pwd)/../data/subjects/pubeng/exam-template.json"
WORK=$(mktemp -d)

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -- -"$SERVER_PGID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -f .dev.vars
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }

echo "== 准备本地数据库：公共英语全部导入，翻译题的采分点当作已确认，全部发布 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-uipe
SETUP_TOKEN=test-setup-uipe
ENCRYPTION_KEY=test-encryption-key-uipe
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
SEED_SUBJECT_DIR="$(pwd)/../data/subjects/pubeng" node ../scripts/build-seed-sql.mjs "$WORK/seed" > "$WORK/seed.log" 2>&1 \
  || { echo "公共英语种子生成失败："; cat "$WORK/seed.log"; exit 1; }
for f in "$WORK"/seed/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$f" >/dev/null 2>&1 || { echo "导入 $f 失败"; exit 1; }
done
source test/lib/d1.sh
# 线上那 32 道翻译题等管理员在后台确认；这里直接当作确认过，才组得出整卷
exec_sql "UPDATE questions SET answer_state = '已确认', answer_reviewed_by = 'ui-pubeng' WHERE course_code = 'pubeng-main';
          UPDATE system_settings SET value = '1000' WHERE key IN ('limit.exam_per_minute', 'limit.exam_per_day');"
npx wrangler d1 execute "$D1_NAME" --local --file=test/fixtures/publish-all.sql >/dev/null 2>&1
check_pub=$(one "SELECT COUNT(*) FROM questions WHERE course_code = 'pubeng-main' AND status = '已发布';")
echo "  已发布 $check_pub 题"
[ "$check_pub" -gt 0 ] || { echo "一道题都没发布出来"; exit 1; }

echo "== 启动 AI 替身与服务 =="
node test/ai-stub.mjs "$STUB_PORT" > /tmp/ui-pubeng-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/ui-pubeng-dev.log
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1
done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-uipe' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "http://127.0.0.1:$STUB_PORT/v1" '{baseUrl:$u,apiKey:"stub-key",model:"stub-model",protocol:"openai"}')"
UI_PASS=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"UIP01","subjects":["pubeng"]}' | jq -r '.initialPassword')
[ -n "$UI_PASS" ] && [ "$UI_PASS" != null ] || { echo "建学员账号失败"; exit 1; }
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$UI_PASS" '{username:"UIP01",password:$p}')" | jq -r '.token')
post() { curl -s -X POST "$BASE$1" -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d "$2"; }

echo "== 每种大题开三次练习（一种宽度一次） =="
SECTION_TYPES='["拼写单词","词组翻译","句子翻译","段落翻译","段落填空","阅读理解","选择填空"]'
PRACTICE='{}'
for st in $(echo "$SECTION_TYPES" | jq -r '.[]'); do
  ids='[]'
  for i in 1 2 3; do
    p=$(post /practice/start "$(jq -nc --arg s "$st" '{courseCode:"pubeng-main",sectionTypes:[$s]}')" | jq -r '.attemptId // empty')
    [ -n "$p" ] || { echo "开「$st」练习失败"; exit 1; }
    ids=$(echo "$ids" | jq -c --arg p "$p" '. + [$p]')
  done
  PRACTICE=$(echo "$PRACTICE" | jq -c --arg s "$st" --argjson v "$ids" '. + {($s): $v}')
done

# 拼写单词有一个得分单元，页面按"一空一框"存成 {"1":"…"}；接口预填也用这个形状，页面才认得是填过的
# 浏览器按题干认题、查该填什么。题干开头（去空白前 24 个字）当键：重复了就认不出是哪道，当场停
KEYS=$(sql "SELECT q.stem, q.question_type AS qt, q.answer FROM questions q WHERE q.course_code = 'pubeng-main';" \
  | jq -c '[.[0].results[] | {key: (.stem | gsub("\\s"; "") | .[0:24]), value: {qt, answer}}] | from_entries')
NK=$(echo "$KEYS" | jq 'length')
# 教学重点和样卷里有几句完全一样的题（同一个键）：答案也一样就无所谓认成哪道；答案不一样就当场停
CONFLICT=$(sql "SELECT q.stem, q.question_type AS qt, q.answer FROM questions q WHERE q.course_code = 'pubeng-main';" \
  | jq '[.[0].results[] | {k: (.stem | gsub("\\s"; "") | .[0:24]), v: "\(.qt)|\(.answer)"}] | group_by(.k)
        | map(select((map(.v) | unique | length) > 1)) | length')
echo "  题干键 $NK 个；同一个键答案不同的 $CONFLICT 组"
[ "$CONFLICT" = "0" ] || { echo "有题干开头一样、答案不同的题，浏览器认不出是哪道"; exit 1; }

echo "== 三张模考卷：客观题按标准答案填好，每种主观题和拼写各留一道给浏览器填 =="
EXAMS=()
for i in 1 2 3; do
  AID=$(post /exams/generate '{"courseCode":"pubeng-main"}' | jq -r '.attemptId // empty')
  [ -n "$AID" ] || { echo "组卷失败（第 $i 张）：$(post /exams/generate '{"courseCode":"pubeng-main"}')"; exit 1; }
  EXAMS+=("$AID")
  sql "SELECT aq.question_id AS qid, q.question_type AS qt, q.answer FROM attempt_questions aq
         JOIN questions q ON q.question_id = aq.question_id WHERE aq.attempt_id = '$AID' ORDER BY aq.ord;" \
    | jq -r '.[0].results
      | (map(select(.qt != "single_choice")) | group_by(.qt) | map(.[0].qid)) as $leave
      | .[] | select(.qid as $q | $leave | index($q) | not)
      | [.qid, (if .qt == "single_choice" then .answer
                elif .qt == "spell_word" then ({"1": .answer} | tojson)
                else "【全对】接口填的答案" end | @base64)] | @tsv' \
    > "$WORK/answers.tsv"
  while IFS=$'\t' read -r qid a64; do
    curl -s -o /dev/null -X PUT "$BASE/attempts/$AID/answers" -H "Authorization: Bearer $STU" \
      -H 'Content-Type: application/json' \
      -d "$(jq -n --arg q "$qid" --arg v "$(printf '%s' "$a64" | base64 -d)" '{questionId:$q,answer:$v}')"
  done < "$WORK/answers.tsv"
done
# 期望值从模板现算
N_SPELL=$(jq -r '[.items[] | select(.filter.questionTypes // [] | index("spell_word")) | .questionCount] | add' "$TPL_JSON")
N_LONG=$(jq -r '[.items[] | select(.filter.questionTypes // [] | (index("phrase_translate") or index("sentence_translate") or index("paragraph_translate"))) | .questionCount] | add' "$TPL_JSON")
N_ALL=$(jq -r '[.items[].questionCount] | add' "$TPL_JSON")
TOTAL=$(jq -r '.totalScore' "$TPL_JSON")
echo "  每卷 $N_ALL 题、满分 $TOTAL；拼写 $N_SPELL 题，翻译 $N_LONG 题"

echo "== 浏览器检查 =="
UI_BASE="http://127.0.0.1:$PORT" UI_USER=UIP01 UI_PASS="$UI_PASS" UI_PRACTICE="$PRACTICE" UI_KEYS="$KEYS" \
  UI_EXAMS="$(printf '%s\n' "${EXAMS[@]}" | jq -R . | jq -sc .)" \
  UI_N_SPELL="$N_SPELL" UI_N_LONG="$N_LONG" UI_N_ALL="$N_ALL" UI_TOTAL="$TOTAL" \
  node test/ui-pubeng.mjs
