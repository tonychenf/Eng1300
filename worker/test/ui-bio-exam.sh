#!/usr/bin/env bash
# 生化学员端的浏览器检查（2026-10-04）：练习、模考作答、成绩报告、历史记录，三种宽度。
#
# 以前没有任何一套用浏览器打开过生化的名词解释：前端按题型名猜控件，不是作文、不是填空就当
# 选择题渲染，名词解释没有选项，一打开整页白屏；生化填空也被套上英语的"给定词："。
# 服务端套件全绿，学员那边是白屏——所以这里断的是"看得见、点得动"，不是"元素在页面代码里"。
#
# 卷子、练习、每道题该填什么都在这里准备好再交给浏览器用例（同 ui-items.sh 的理由：
# 让用例自己在页面上找题是靠猜，猜错了会在别的题上全绿）。
set -uo pipefail
cd "$(dirname "$0")/.."

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8773          # 端口表见 CLAUDE.md
STUB_PORT=8888
BASE="http://127.0.0.1:$PORT/api"
TPL_JSON="$(pwd)/../data/subjects/biochem/exam-template.json"
WORK=$(mktemp -d)

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -- -"$SERVER_PGID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -f .dev.vars
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }

echo "== 准备本地数据库：生化第 1 章核完、发布 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-uibio
SETUP_TOKEN=test-setup-uibio
ENCRYPTION_KEY=test-encryption-key-uibio
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
SEED_SUBJECT_DIR="$(pwd)/../data/subjects/biochem" node ../scripts/build-seed-sql.mjs "$WORK/seed" > "$WORK/seed.log" 2>&1 \
  || { echo "生化种子生成失败："; cat "$WORK/seed.log"; exit 1; }
for f in "$WORK"/seed/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$f" >/dev/null 2>&1 || { echo "导入 $f 失败"; exit 1; }
done
source test/lib/d1.sh   # sql / one / exec_sql（读库失败会在 stderr 报出来）
exec_sql "UPDATE questions SET answer_state = '已确认' WHERE course_code = 'biochem-main';
          UPDATE questions SET status = '草稿' WHERE course_code = 'biochem-main' AND status = '存疑';
          UPDATE system_settings SET value = '1000' WHERE key IN ('limit.exam_per_minute', 'limit.exam_per_day');"
npx wrangler d1 execute "$D1_NAME" --local --file=test/fixtures/publish-all.sql >/dev/null 2>&1

echo "== 启动 AI 替身与服务 =="
node test/ai-stub.mjs "$STUB_PORT" > /tmp/ui-bio-exam-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/ui-bio-exam-dev.log
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1
done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-uibio' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "http://127.0.0.1:$STUB_PORT/v1" '{baseUrl:$u,apiKey:"stub-key",model:"stub-model",protocol:"openai"}')"
UI_PASS=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"UIB01","subjects":["biochem"]}' | jq -r '.initialPassword')
[ -n "$UI_PASS" ] && [ "$UI_PASS" != null ] || { echo "建学员账号失败"; exit 1; }
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$UI_PASS" '{username:"UIB01",password:$p}')" | jq -r '.token')
post() { curl -s -X POST "$BASE$1" -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' -d "$2"; }

echo "== 三张卷（一种宽度一张）：客观题按题库填好，主观题留第一道名词解释给浏览器写 =="
EXAMS=()
for i in 1 2 3; do
  AID=$(post /exams/generate '{"courseCode":"biochem-main"}' | jq -r '.attemptId // empty')
  [ -n "$AID" ] || { echo "组卷失败（第 $i 张）"; exit 1; }
  EXAMS+=("$AID")
  sql "SELECT aq.ord, aq.question_id AS qid, aq.section_ord AS sec, q.question_type AS qt, q.answer
         FROM attempt_questions aq JOIN questions q ON q.question_id = aq.question_id
        WHERE aq.attempt_id = '$AID' ORDER BY aq.ord;" | jq '.[0].results' > "$WORK/paper.json"
  sql "SELECT question_id AS qid, item_ord AS ord, grading_strategy AS strategy, group_key AS g, answer, params
         FROM question_items WHERE question_id IN (SELECT question_id FROM attempt_questions WHERE attempt_id = '$AID')
        ORDER BY question_id, item_ord;" | jq '.[0].results' > "$WORK/items.json"
  node - "$WORK/paper.json" "$WORK/items.json" > "$WORK/answers.tsv" <<'NODE'
const fs = require('fs');
const paper = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const items = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
let firstTerm = true;
for (const q of paper) {
  const its = items.filter((it) => it.qid === q.qid);
  let a;
  if (q.qt === 'single_choice') a = q.answer;
  else if (q.qt === 'fill_text') {
    const out = {}; const groups = new Map();
    for (const it of its) {
      if (it.strategy === 'SET') { if (!groups.has(it.g)) groups.set(it.g, []); groups.get(it.g).push(it); }
      else out[it.ord] = it.answer;
    }
    for (const list of groups.values()) {
      const p = JSON.parse(list.find((x) => x.params)?.params || '{}');
      list.sort((x, y) => x.ord - y.ord).forEach((it, k) => { out[it.ord] = p.pool[k]; });
    }
    a = JSON.stringify(out);
  } else if (q.qt === 'term_explain' && firstTerm) { firstTerm = false; continue; }   // 留给浏览器写
  else a = `【全对】接口填的答案 ${q.qid}`;
  process.stdout.write(`${q.qid}\t${Buffer.from(a).toString('base64')}\n`);
}
NODE
  while IFS=$'\t' read -r qid a64; do
    curl -s -o /dev/null -X PUT "$BASE/attempts/$AID/answers" -H "Authorization: Bearer $STU" \
      -H 'Content-Type: application/json' \
      -d "$(jq -n --arg q "$qid" --arg v "$(printf '%s' "$a64" | base64 -d)" '{questionId:$q,answer:$v}')"
  done < "$WORK/answers.tsv"
done
# 期望值从模板文件现算：主观题几道、几分，整卷满分
N_SUBJ=$(jq -r '[.items[] | select(.filter.questionTypes | index("term_explain") or index("short_answer")) | .questionCount] | add' "$TPL_JSON")
SUBJ_PTS=$(jq -r '[.items[] | select(.filter.questionTypes | index("term_explain") or index("short_answer")) | .questionCount * .scorePerQuestion] | add' "$TPL_JSON")
TOTAL=$(jq -r '.totalScore' "$TPL_JSON")
TERM_SEC=$(jq -r '.items[] | select(.filter.questionTypes | index("term_explain")) | .ord' "$TPL_JSON")
TERM_N=$(jq -r '.items[] | select(.filter.questionTypes | index("term_explain")) | .questionCount' "$TPL_JSON")
FILL_SEC=$(jq -r '.items[] | select(.filter.questionTypes | index("fill_text")) | .ord' "$TPL_JSON")
PARTS=$(jq -r '.items | length' "$TPL_JSON")
echo "  主观题 $N_SUBJ 道 $SUBJ_PTS 分，满分 $TOTAL；名词解释在第 $TERM_SEC 部分（$TERM_N 道），填空在第 $FILL_SEC 部分"

echo "== 练习：三个名词解释练习；填空练习只留一道答案已知的多空题（q06） =="
TERMP=()
for i in 1 2 3; do
  TERMP+=("$(post /practice/start '{"courseCode":"biochem-main","sectionTypes":["名词解释"]}' | jq -r '.attemptId')")
done
# 卷子已经组好了，这时停用别的填空题不影响上面三张卷；练习的范围里就只剩 q06
FILLQ=biochem-ch01-q06
exec_sql "UPDATE questions SET retired_at = datetime('now'), status = '草稿'
           WHERE course_code = 'biochem-main' AND question_type = 'fill_text' AND question_id <> '$FILLQ';"
FILLP=()
for i in 1 2 3; do
  FILLP+=("$(post /practice/start '{"courseCode":"biochem-main","sectionTypes":["填空题"]}' | jq -r '.attemptId')")
done
# q06 每个空该填什么：候选池（SET）按顺序取、其余取标准答案，读出来按空的序号排好
FILL_ANS=$(sql "SELECT item_ord AS ord, grading_strategy AS strategy, group_key AS g, answer, params FROM question_items
                 WHERE question_id = '$FILLQ' ORDER BY item_ord;" | jq -c '.[0].results
  | (map(select(.params != null) | {key: .g, value: (.params | fromjson | .pool)}) | from_entries) as $pools
  | reduce .[] as $it ({out: [], used: {}};
      if $it.strategy == "SET" then
        .out += [$pools[$it.g][(.used[$it.g] // 0)]] | .used[$it.g] = ((.used[$it.g] // 0) + 1)
      else .out += [$it.answer] end) | .out')
echo "  q06 的答案：$FILL_ANS"
# 再开三个：浏览器在这里故意把候选池的一空填错，看页面给不给可填的答案、错题本读不读得懂（2026-10-07）
FILLW=()
for i in 1 2 3; do
  FILLW+=("$(post /practice/start '{"courseCode":"biochem-main","sectionTypes":["填空题"]}' | jq -r '.attemptId')")
done
POOL6=$(sql "SELECT params FROM question_items WHERE question_id = '$FILLQ' AND params IS NOT NULL ORDER BY item_ord LIMIT 1;" \
  | jq -c '.[0].results[0].params | fromjson | .pool')
STEM6=$(one "SELECT substr(stem, 1, 16) FROM questions WHERE question_id = '$FILLQ';")
echo "  q06 的候选池：$POOL6"
for v in "${TERMP[@]}" "${FILLP[@]}" "${FILLW[@]}"; do [ -n "$v" ] && [ "$v" != null ] || { echo "开练习失败"; exit 1; }; done

echo "== 浏览器检查 =="
UI_BASE="http://127.0.0.1:$PORT" UI_USER=UIB01 UI_PASS="$UI_PASS" \
  UI_EXAMS="$(printf '%s\n' "${EXAMS[@]}" | jq -R . | jq -sc .)" \
  UI_TERMP="$(printf '%s\n' "${TERMP[@]}" | jq -R . | jq -sc .)" \
  UI_FILLP="$(printf '%s\n' "${FILLP[@]}" | jq -R . | jq -sc .)" \
  UI_FILLW="$(printf '%s\n' "${FILLW[@]}" | jq -R . | jq -sc .)" UI_POOL6="$POOL6" UI_STEM6="$STEM6" \
  UI_FILL_ANS="$FILL_ANS" UI_N_SUBJ="$N_SUBJ" UI_SUBJ_PTS="$SUBJ_PTS" UI_TOTAL="$TOTAL" \
  UI_TERM_SEC="$TERM_SEC" UI_TERM_N="$TERM_N" UI_FILL_SEC="$FILL_SEC" UI_PARTS="$PARTS" \
  node test/ui-bio-exam.mjs
