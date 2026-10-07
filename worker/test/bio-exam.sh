#!/usr/bin/env bash
# 生化模考端到端（2026-10-04）：组卷模板进库 → 组卷 → 作答 → 交卷 → AI 按采分点批改 → 报告。
#
# 这一套以前不存在，所以下面这些事一件都没人发现过：
#   - 生化的组卷模板只写在 data/subjects/biochem/exam-template.json 里，从没进过库，一点组卷就 422；
#   - 名词解释、问答（采分点式）交卷后的 AI 批改一律走英语作文的维度打分，当场抛错、永远"待批改"；
#   - 第 1 章的 q04、q05（受限选择的空）题库文件写的是 params.enum、判分器只认 options，
#     一判分就抛错——交卷整个 500。
# 期望值一律从题库文件 / 组卷模板文件 / 库里的得分单元现算，不拿接口自己的数去对接口。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8774          # 端口表见 CLAUDE.md
STUB_PORT=8889
BASE="http://127.0.0.1:$PORT/api"
STUB="http://127.0.0.1:$STUB_PORT"
TPL_JSON="$ROOT_DIR/../data/subjects/biochem/exam-template.json"
BANK_JSON="$ROOT_DIR/../data/subjects/biochem/groups/biochem-ch01.json"
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

source "$ROOT_DIR/test/lib/d1.sh"   # sql / one / exec_sql（读库失败会在 stderr 报出来）

if [ ! -d public ]; then echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; fi

echo "== 准备本地数据库：先迁到 0016，看清楚 0017 之前是什么样 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-bioexam
SETUP_TOKEN=test-setup-bioexam
ENCRYPTION_KEY=test-encryption-key-bioexam
VARS
M17=migrations/0017_biochem_exam.sql
[ -f "$M17" ] || { echo "找不到 $M17"; exit 1; }
for m in migrations/*.sql; do
  [ "$m" = "$M17" ] && continue
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "迁移 $m 失败"; exit 1; }
done
check "（改之前的样子）生化课程没有组卷模板" \
  "$(one "SELECT COUNT(*) FROM exam_template_items WHERE course_code = 'biochem-main';")" "0"
BIO_SID=$(one "SELECT subject_id FROM subjects WHERE code = 'biochem';")
check "（改之前的样子）生化的主观题批改提示词是照抄英语作文的那份" \
  "$(one "SELECT instr(user_template, '学生作文') > 0 FROM subject_ai_prompts WHERE subject_id = $BIO_SID AND feature = 'essay_grade';")" "1"
EN_PROMPT_BEFORE=$(one "SELECT user_template FROM subject_ai_prompts WHERE subject_id = (SELECT subject_id FROM subjects WHERE code = 'english') AND feature = 'essay_grade';")

npx wrangler d1 execute "$D1_NAME" --local --file="$M17" >/dev/null 2>&1 || { echo "迁移 0017 失败"; exit 1; }

echo
echo "== 0017：模板和文件逐项一致 =="
# 期望从模板文件现算；库里的 filter 先解析再排好键，免得空格、键序不同被当成不一致
jq -r '.items | sort_by(.ord)[] | [.ord, .label, (.filter | tojson), .questionCount, .scoreMode, .scorePerQuestion, .pickUnit] | @tsv' \
  "$TPL_JSON" > "$WORK/tpl-want.tsv"
sql "SELECT ord, label, filter, question_count, score_mode, score_per_question, pick_unit
       FROM exam_template_items WHERE course_code = 'biochem-main' ORDER BY ord;" \
  | jq -r '.[0].results[] | [.ord, .label, (.filter | fromjson | tojson), .question_count, .score_mode, .score_per_question, .pick_unit] | @tsv' \
  > "$WORK/tpl-got.tsv"
check "模板 $(wc -l < "$WORK/tpl-want.tsv") 项，每项的题型、题量、分值、抽题单位和 exam-template.json 一致" \
  "$(diff "$WORK/tpl-want.tsv" "$WORK/tpl-got.tsv" >/dev/null && echo 一致 || { diff "$WORK/tpl-want.tsv" "$WORK/tpl-got.tsv" | head -6; echo 不一致; })" "一致"
WANT_TOTAL=$(jq -r '.totalScore' "$TPL_JSON")
WANT_N=$(jq -r '[.items[].questionCount] | add' "$TPL_JSON")
check "（前提）模板文件自洽：各项题量 × 分值加起来正好是总分 $WANT_TOTAL" \
  "$(jq -r '[.items[] | .questionCount * .scorePerQuestion] | add' "$TPL_JSON")" "$WANT_TOTAL"
check "生化的主观题批改提示词换成了按采分点批的那份" \
  "$(one "SELECT (instr(user_template, '{{pointLines}}') > 0) || '/' || (instr(user_template, '学生作文') > 0) FROM subject_ai_prompts WHERE subject_id = $BIO_SID AND feature = 'essay_grade';")" "1/0"
check "英语的作文批改提示词一个字没动" \
  "$(one "SELECT user_template FROM subject_ai_prompts WHERE subject_id = (SELECT subject_id FROM subjects WHERE code = 'english') AND feature = 'essay_grade';")" \
  "$EN_PROMPT_BEFORE"

echo
echo "== 0017 每次部署都重跑：门闩让它只装一次 =="
# 删掉一项、改一项，再跑一遍 0017：删掉的不会被插回来，改过的不会被冲回去
exec_sql "DELETE FROM exam_template_items WHERE course_code = 'biochem-main' AND ord = 4;
          UPDATE exam_template_items SET question_count = 11 WHERE course_code = 'biochem-main' AND ord = 1;"
npx wrangler d1 execute "$D1_NAME" --local --file="$M17" >/dev/null 2>&1
check "删掉的第 4 项没被插回来" "$(one "SELECT COUNT(*) FROM exam_template_items WHERE course_code = 'biochem-main';")" "3"
check "改过的第 1 项题量没被冲回去" \
  "$(one "SELECT question_count FROM exam_template_items WHERE course_code = 'biochem-main' AND ord = 1;")" "11"
# 恢复：照模板文件写回去（不从迁移拿，迁移已经被门闩挡住了）
exec_sql "UPDATE exam_template_items SET question_count = 12 WHERE course_code = 'biochem-main' AND ord = 1;
          INSERT INTO exam_template_items (course_code, ord, label, filter, question_count, score_mode, score_per_question, pick_unit)
          VALUES ('biochem-main', 4, '问答题', '{\"questionTypes\":[\"short_answer\"]}', 2, 'FROM_TEMPLATE', 11, 'QUESTION');"
check "（恢复）模板又是 4 项" "$(one "SELECT COUNT(*) FROM exam_template_items WHERE course_code = 'biochem-main';")" "4"
# 提示词：后台改过的不动。拆掉门闩单独测"只在原文时改"这一条（门闩挡着的话这条测不到）
NEW_TPL_LEN=$(one "SELECT length(user_template) FROM subject_ai_prompts WHERE subject_id = $BIO_SID AND feature = 'essay_grade';")
exec_sql "UPDATE subject_ai_prompts SET user_template = user_template || '（后台改过）' WHERE subject_id = $BIO_SID AND feature = 'essay_grade';
          DELETE FROM seed_state WHERE name = 'biochem-subjective-prompt';"
npx wrangler d1 execute "$D1_NAME" --local --file="$M17" >/dev/null 2>&1
check "后台改过的生化提示词，0017 重跑也不动（只认 0009 的原文）" \
  "$(one "SELECT instr(user_template, '（后台改过）') > 0 FROM subject_ai_prompts WHERE subject_id = $BIO_SID AND feature = 'essay_grade';")" "1"
exec_sql "UPDATE subject_ai_prompts SET user_template = substr(user_template, 1, $NEW_TPL_LEN) WHERE subject_id = $BIO_SID AND feature = 'essay_grade';"

echo
echo "== 导生化第 1 章、核完答案、发布 =="
SEED="$WORK/seed-bio"
SEED_SUBJECT_DIR="$ROOT_DIR/../data/subjects/biochem" node ../scripts/build-seed-sql.mjs "$SEED" > "$WORK/seed.log" 2>&1 \
  || { echo "生化种子生成失败："; cat "$WORK/seed.log"; exit 1; }
for f in "$SEED"/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$f" >/dev/null 2>&1 || { echo "导入 $f 失败"; exit 1; }
done
# 线上是管理员在后台逐题确认、处理完存疑之后发布的（2026-09-25）；这里一步到位造出同样的状态
exec_sql "UPDATE questions SET answer_state = '已确认' WHERE course_code = 'biochem-main';
          UPDATE questions SET status = '草稿' WHERE course_code = 'biochem-main' AND status = '存疑';"
npx wrangler d1 execute "$D1_NAME" --local --file=test/fixtures/publish-all.sql >/dev/null 2>&1
# 本套一分钟内组好几份卷，放开组卷限流（限流本身在 cr-auth-limits 测）
exec_sql "UPDATE system_settings SET value = '1000' WHERE key IN ('limit.exam_per_minute', 'limit.exam_per_day');"
FILE_N=$(jq '[.sections[].questions | length] | add' "$BANK_JSON")
check "（前提）第 1 章 $FILE_N 道题全部发布了" \
  "$(one "SELECT COUNT(*) FROM questions WHERE course_code = 'biochem-main' AND status = '已发布';")" "$FILE_N"
# 每类题有几道，从题库文件现算，打出来——模板题量和它一样时每张卷都是整章
jq -r '[.sections[].questions[].questionType] | group_by(.) | map("\(.[0]) \(length)") | join("、")' "$BANK_JSON" \
  | sed 's/^/     （题库文件里：/; s/$/）/'

echo
echo "== 启动 AI 替身与服务 =="
node test/ai-stub.mjs "$STUB_PORT" > /tmp/bio-exam-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/bio-exam-dev.log
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
ready=0
for i in $(seq 1 150); do
  curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1
done
[ "$ready" = "1" ] || { echo "服务在 150 秒内没有就绪。dev 日志尾部："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-bioexam' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
PW=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"BIO001","subjects":["biochem"]}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$PW" '{username:"BIO001",password:$p}')" | jq -r '.token')
[ -n "$STU" ] && [ "$STU" != null ] || { echo "学员登录失败"; exit 1; }
curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "$STUB/v1" '{baseUrl:$u,apiKey:"stub-key",model:"stub-model",protocol:"openai"}')"
au() { curl -s -H "Authorization: Bearer $STU" "$@"; }
adm() { curl -s -H "Authorization: Bearer $ADMIN" "$@"; }

echo
echo "== 后台：上传页能不能选这个学科，由导入方式说了算 =="
SUBJ=$(adm "$BASE/admin/subjects")
check "生化能上传（docx 结构化），英语不能（扫描件那条管线本仓库没有）" \
  "$(echo "$SUBJ" | jq -r '[.subjects[] | select(.code == "biochem" or .code == "english") | "\(.code)=\(.uploadable)"] | sort | join(",")')" \
  "biochem=true,english=false"
check "  能上传的说清收什么文件" "$(echo "$SUBJ" | jq -r '.subjects[] | select(.code == "biochem") | .uploadAccepts')" ".docx"

echo
echo "== 组卷：生化能组出一张卷，形状和模板文件一致 =="
GEN=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"biochem-main"}')
AID=$(echo "$GEN" | jq -r '.attemptId // empty')
check "组卷成功（以前：该课程没有配置组卷模板）" "$( [ -n "$AID" ] && echo 成功 || echo "失败：$(echo "$GEN" | head -c 160)")" "成功"
[ -n "$AID" ] || { echo "组不出卷，后面没法测"; echo "== 小结: $PASS 通过, $FAIL 失败 =="; exit 1; }
check "题量 = 模板各项题量之和" "$(echo "$GEN" | jq -r '.questionCount')" "$WANT_N"
check "满分 = 模板文件的总分" "$(echo "$GEN" | jq -r '.totalScore')" "$WANT_TOTAL"
check "时长 = 模板文件的时长" "$(echo "$GEN" | jq -r '.timeLimitMinutes')" "$(jq -r '.timeLimitMinutes' "$TPL_JSON")"
check "四个部分的名称、题量、小计和模板文件一致" \
  "$(echo "$GEN" | jq -r '[.sections[] | "\(.sectionType):\(.questionCount):\(.totalScore)"] | join(",")')" \
  "$(jq -r '[.items | sort_by(.ord)[] | "\(.label):\(.questionCount):\(.questionCount * .scorePerQuestion)"] | join(",")' "$TPL_JSON")"
check "每一部分抽到的题都是模板筛选的题型" \
  "$(sql "SELECT COUNT(*) AS n FROM attempt_questions aq JOIN questions q ON q.question_id = aq.question_id
           JOIN exam_template_items t ON t.course_code = 'biochem-main' AND t.ord = aq.section_ord
          WHERE aq.attempt_id = '$AID'
            AND instr(t.filter, '\"' || q.question_type || '\"') = 0;" | jq -r '.[0].results[0].n')" "0"
check "整章 $FILE_N 道各出现一次（题量正好等于模板要求，卷子就是整章）" \
  "$(one "SELECT COUNT(DISTINCT question_id) FROM attempt_questions WHERE attempt_id = '$AID';")" "$FILE_N"
check "第 1 次组卷不提示重复" "$(echo "$GEN" | jq -r '.warnings | length')" "0"

echo
echo "== 作答：客观题照题库全答对，主观题各走一条路 =="
# 把这张卷的题和得分单元读出来，按题型给答案。客观题的标准答案取自库里的得分单元 / 选择题答案，
# 候选池（SET）取池子里的前 requiredCount 个，受限选择（ENUM）取标准答案。
sql "SELECT aq.ord, aq.question_id AS qid, aq.score_per_question AS pts, q.question_type AS qt, q.answer
       FROM attempt_questions aq JOIN questions q ON q.question_id = aq.question_id
      WHERE aq.attempt_id = '$AID' ORDER BY aq.ord;" | jq '.[0].results' > "$WORK/paper.json"
sql "SELECT question_id AS qid, item_ord AS ord, item_kind AS kind, grading_strategy AS strategy,
            group_key AS g, answer, weight, params
       FROM question_items WHERE question_id IN (SELECT question_id FROM attempt_questions WHERE attempt_id = '$AID')
      ORDER BY question_id, item_ord;" | jq '.[0].results' > "$WORK/items.json"
# 主观题按卷面顺序分配记号（替身按记号决定怎么回，见 ai-stub.mjs）
node - "$WORK/paper.json" "$WORK/items.json" > "$WORK/answers.tsv" <<'NODE'
const fs = require('fs');
const paper = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const items = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const byQ = new Map();
for (const it of items) { if (!byQ.has(it.qid)) byQ.set(it.qid, []); byQ.get(it.qid).push(it); }
const TERM = ['【全对】', '【全错】', '【单号】', '【坏键】', '【照抄】', null, '【非对象】'];   // null = 不作答
const SHORT = ['【单号】', '【全对】'];
let t = 0, s = 0;
for (const q of paper) {
  const its = byQ.get(q.qid) || [];
  let answer, plan;
  if (q.qt === 'single_choice') { answer = q.answer; plan = 'objective'; }
  else if (q.qt === 'fill_text') {
    const out = {};
    const groups = new Map();
    for (const it of its) {
      if (it.strategy === 'SET') {
        if (!groups.has(it.g)) groups.set(it.g, []);
        groups.get(it.g).push(it);
      } else out[it.ord] = it.answer;
    }
    for (const list of groups.values()) {
      const p = JSON.parse(list.find((x) => x.params)?.params || '{}');
      list.sort((a, b) => a.ord - b.ord).forEach((it, i) => { out[it.ord] = p.pool[i]; });
    }
    answer = JSON.stringify(out); plan = 'objective';
  } else {
    const mark = q.qt === 'term_explain' ? TERM[t++] : SHORT[s++];
    plan = mark === null ? 'blank' : mark;
    answer = mark === null ? '' : `${mark}学生写的一段话：${q.qid}`;
  }
  process.stdout.write([q.qid, q.qt, q.pts, plan, Buffer.from(answer).toString('base64')].join('\t') + '\n');
}
NODE
while IFS=$'\t' read -r qid qt pts plan ans64; do
  ans=$(printf '%s' "$ans64" | base64 -d)
  [ -z "$ans" ] && continue
  curl -s -o /dev/null -X PUT "$BASE/attempts/$AID/answers" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d "$(jq -n --arg q "$qid" --arg v "$ans" '{questionId:$q,answer:$v}')"
done < "$WORK/answers.tsv"
echo "     （主观题的安排：$(awk -F'\t' '$4 != "objective" {printf "%s=%s ", $1, $4}' "$WORK/answers.tsv" | sed 's/biochem-ch01-//g')）"

SUB=$(curl -s -X POST "$BASE/attempts/$AID/submit" -H "Authorization: Bearer $STU")
WANT_OBJ=$(awk -F'\t' '$4 == "objective" {s += $3} END {print s + 0}' "$WORK/answers.tsv")
check "交卷成功（以前：q04/q05 的受限选择一判分就抛错，整张卷交不上）" \
  "$(echo "$SUB" | jq -r 'has("objectiveScore")')" "true"
check "客观题全答对 = 客观题满分 $WANT_OBJ（从卷面现加）" "$(echo "$SUB" | jq -r '.objectiveScore')" "$WANT_OBJ"
N_SUBJ=$(awk -F'\t' '$4 != "objective"' "$WORK/answers.tsv" | wc -l)
check "名词解释、问答 $N_SUBJ 道都在等 AI 批改" "$(echo "$SUB" | jq -r '.pendingAi')" "$N_SUBJ"
REP0=$(au "$BASE/attempts/$AID/report")
echo "$REP0" | jq -c '.sectionScores' > "$WORK/sections-before.json"
check "报告里带着每道题的作答控件：名词解释、问答是大文本框" \
  "$(echo "$REP0" | jq -r '[.sections[].questions[] | select(.questionType == "term_explain" or .questionType == "short_answer") | .inputWidget] | unique | join(",")')" "textarea"
check "  每道题带着它在本卷的分值，加起来是满分" \
  "$(echo "$REP0" | jq -r '[.sections[].questions[].points] | add')" "$WANT_TOTAL"

echo
echo "== AI 按采分点批改 =="
curl -s -o /dev/null "$STUB/stats?reset=1"
RUN=$(curl -s -X POST "$BASE/ai/attempts/$AID/run" -H "Authorization: Bearer $STU")
echo "$RUN" | jq -c '.subjective | {total, graded, blank, already, failed, score}' | sed 's/^/     （/; s/$/）/'
plan_count() { awk -F'\t' -v p="$1" '$4 == p' "$WORK/answers.tsv" | wc -l; }
N_GRADED=$(( $(plan_count '【全对】') + $(plan_count '【全错】') + $(plan_count '【单号】') ))
N_FAILED=$(( $(plan_count '【坏键】') + $(plan_count '【照抄】') + $(plan_count '【非对象】') ))
check "批改了 $N_GRADED 道、没作答 1 道、读不懂 $N_FAILED 道" \
  "$(echo "$RUN" | jq -r '.subjective | "\(.graded)/\(.blank)/\(.failed)/\(.already)"')" "$N_GRADED/1/$N_FAILED/0"
check "以前那条路（英语作文维度打分）没有被走到" "$(echo "$RUN" | jq -r '.essay')" "null"
qid_of() { awk -F'\t' -v p="$1" '$4 == p {print $1; exit}' "$WORK/answers.tsv"; }
fail_of() { echo "$RUN" | jq -r --arg q "$1" '.subjective.failures[] | select(.questionId == $q) | "\(.error)|\(.detail)"'; }
check "少一个采分点、多一个不存在的：当没读懂，点名缺哪个、多哪个" \
  "$(fail_of "$(qid_of '【坏键】')" | grep -c '^ai_bad_shape|.*缺 1.*多出 "99"')" "1"
check "照抄提示里的示例（全部没答到、理由全空）：当没读懂，不记 0 分" \
  "$(fail_of "$(qid_of '【照抄】')" | grep -c '^ai_bad_shape|.*原样抄了回来')" "1"
check "points 回成一句话：当没读懂" \
  "$(fail_of "$(qid_of '【非对象】')" | grep -c '^ai_bad_shape|.*points 要是对象')" "1"
for p in '【坏键】' '【照抄】' '【非对象】'; do
  check "  $p 那道没落分、没标已批改（下次点按钮会重试）" \
    "$(one "SELECT COALESCE(score, 'NULL') || '/' || COALESCE(ai_judged, 0) FROM answer_records WHERE attempt_id = '$AID' AND question_id = '$(qid_of "$p")';")" "NULL/0"
done
check "没作答的那道直接 0 分、标已批改" \
  "$(one "SELECT printf('%g', score) || '/' || ai_judged || '/' || ai_comment FROM answer_records WHERE attempt_id = '$AID' AND question_id = '$(qid_of blank)';")" "0/1/未作答"

# 每道批改了的题：期望分从库里的采分点权重现算（得分率 = 命中权重 / 总权重 × 本卷分值，B11），
# 命中规则是替身的：【全对】全中、【全错】全不中、【单号】单号中双号不中
node - "$WORK/answers.tsv" "$WORK/items.json" > "$WORK/expect.tsv" <<'NODE'
const fs = require('fs');
const rows = fs.readFileSync(process.argv[2], 'utf8').trim().split('\n').map((l) => l.split('\t'));
const items = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const round6 = (n) => Math.round(n * 1e6) / 1e6;
for (const [qid, , pts, plan] of rows) {
  if (!['【全对】', '【全错】', '【单号】'].includes(plan)) continue;
  const its = items.filter((it) => it.qid === qid && it.kind === 'SCORE_POINT');
  const hit = (it) => (plan === '【全对】' ? true : plan === '【全错】' ? false : it.ord % 2 === 1);
  const total = its.reduce((n, it) => n + it.weight, 0);
  const rate = round6(its.filter(hit).reduce((n, it) => n + it.weight, 0) / total);
  const score = Math.round(rate * Number(pts) * 100) / 100;
  console.log([qid, plan, score, rate >= 1 ? 1 : 0, its.length].join('\t'));
}
NODE
while IFS=$'\t' read -r qid plan want correct npts; do
  check "  ${qid#biochem-ch01-}（$plan）得分 = 命中权重 / 总权重 × 本卷分值 = $want，答对记 $correct" \
    "$(one "SELECT printf('%g', score) || '/' || is_correct || '/' || ai_judged FROM answer_records WHERE attempt_id = '$AID' AND question_id = '$qid';")" \
    "$want/$correct/1"
done < "$WORK/expect.tsv"
WANT_SUB=$(awk -F'\t' '{s += $3} END {printf "%g", s}' "$WORK/expect.tsv")
check "批改得分加起来 = 各题期望分之和" "$(echo "$RUN" | jq -r '.subjective.score')" "$WANT_SUB"
WRONG_Q=$(qid_of '【全错】')
check "全没答到的那道，每个采分点都带着 AI 的理由（报告里逐点显示）" \
  "$(one "SELECT item_results FROM answer_records WHERE attempt_id = '$AID' AND question_id = '$WRONG_Q';" \
     | jq -r '[.[].items[] | select((.reason // "") | test("没有提到"))] | length')" \
  "$(jq --arg q "$WRONG_Q" '[.[] | select(.qid == $q and .kind == "SCORE_POINT")] | length' "$WORK/items.json")"

STATS=$(curl -s "$STUB/stats")
check "调了 $((N_SUBJ - 1)) 次模型（没作答的那道不花钱）" "$(echo "$STATS" | jq -r '.pointsCalls')" "$((N_SUBJ - 1))"
check "并发跑、有上限：同时在飞的最多 3 个、至少 2 个（串行的话永远是 1）" \
  "$(echo "$STATS" | jq -r '.pointsMaxInflight as $m | ($m >= 2 and $m <= 3)')" "true"
# 发给模型的东西：题干、库里的采分点原文、权重、学生答案都在，用的是新模板
RIGHT_Q=$(qid_of '【全对】')
PROMPT=$(curl -s "$STUB/last-prompt" | jq -r --arg q "$RIGHT_Q" '[.prompts[] | select(contains("逐个判断学生答案有没有答到") and contains($q))][0] // ""')
P1=$(jq -r --arg q "$RIGHT_Q" '[.[] | select(.qid == $q and .ord == 1)][0].answer' "$WORK/items.json")
STEM=$(one "SELECT stem FROM questions WHERE question_id = '$RIGHT_Q';")
NPTS=$(jq --arg q "$RIGHT_Q" '[.[] | select(.qid == $q and .kind == "SCORE_POINT")] | length' "$WORK/items.json")
check "学生答案夹在\"学员作答开始 / 结束\"两行标记之间（CR L9：学员不能在答案里给模型下指令）" \
  "$(printf '%s\n' "$PROMPT" | grep -A1 -xF '<<<学员作答开始>>>' | grep -cF "学生写的一段话：$RIGHT_Q")/$(printf '%s\n' "$PROMPT" | grep -cxF '<<<学员作答结束>>>')" "1/1"
check "提示词里有题干、第 1 个采分点原文、$NPTS 个采分点各带权重、学生答案，没有\"学生作文\"" \
  "$(printf '%s' "$PROMPT" | grep -cF "$STEM")/$(printf '%s' "$PROMPT" | grep -cF "$P1")/$(printf '%s' "$PROMPT" | grep -c '^[0-9]*\.（权重 ')/$(printf '%s' "$PROMPT" | grep -cF "学生写的一段话：$RIGHT_Q")/$(printf '%s' "$PROMPT" | grep -c '学生作文')" \
  "1/1/$NPTS/1/0"

echo
echo "== 报告：总分、待批改、各部分得分跟着批改结果走 =="
REP1=$(au "$BASE/attempts/$AID/report")
check "还剩 $N_FAILED 道没批（读不懂的那几道）" "$(echo "$REP1" | jq -r '.attempt.pendingAi')" "$N_FAILED"
check "总分 = 客观题 + 批改得分" "$(echo "$REP1" | jq -r '.attempt.totalScore')" "$(awk -v a="$WANT_OBJ" -v b="$WANT_SUB" 'BEGIN {printf "%g", a + b}')"
check "客观题的两部分和交卷时那份逐字段相等（重算和交卷是两段代码，口径必须一样）" \
  "$(echo "$REP1" | jq -c '[.sectionScores[] | select(.sectionOrd <= 2)]')" \
  "$(jq -c '[.[] | select(.sectionOrd <= 2)]' "$WORK/sections-before.json")"
TERM_SUM=$(awk -F'\t' '{print}' "$WORK/expect.tsv" | while IFS=$'\t' read -r q p w c n; do
  [ "$(awk -F'\t' -v x="$q" '$1 == x {print $2}' "$WORK/answers.tsv")" = term_explain ] && echo "$w"; done | awk '{s += $1} END {printf "%g", s}')
check "名词解释那部分：批了的分加进去、读不懂的 $N_FAILED 道还算待批改（以前批完了还写着待批改）" \
  "$(echo "$REP1" | jq -r '.sectionScores[] | select(.sectionOrd == 3) | "\(.score)/\(.pendingAi)"')" "$TERM_SUM/$N_FAILED"
check "问答那部分批完了，不再待批改" "$(echo "$REP1" | jq -r '.sectionScores[] | select(.sectionOrd == 4) | .pendingAi')" "0"
check "历史记录带着这张卷的满分（以前页面写死 / 70）" \
  "$(au "$BASE/history" | jq -r --arg a "$AID" '.attempts[] | select(.attempt_id == $a) | .max_score')" "$WANT_TOTAL"

echo
echo "== 再点一次：批过的不重批，读不懂的重试 =="
curl -s -o /dev/null "$STUB/stats?reset=1"
# 把一道读不懂的作答换成替身能读懂的（模拟这次模型正常回了），另外两道照旧
FIX_Q=$(qid_of '【照抄】')
exec_sql "UPDATE answer_records SET user_answer = '【全对】换了个回答' WHERE attempt_id = '$AID' AND question_id = '$FIX_Q';"
RUN2=$(curl -s -X POST "$BASE/ai/attempts/$AID/run" -H "Authorization: Bearer $STU")
check "这次批了 1 道、还有 $((N_FAILED - 1)) 道读不懂、$((N_SUBJ - N_FAILED)) 道是批过的" \
  "$(echo "$RUN2" | jq -r '.subjective | "\(.graded)/\(.failed)/\(.already)"')" "1/$((N_FAILED - 1))/$((N_SUBJ - N_FAILED))"
check "  只调了 $N_FAILED 次模型（批过的不再花钱）" "$(curl -s "$STUB/stats" | jq -r '.pointsCalls')" "$N_FAILED"
check "  待批改少了一道" "$(au "$BASE/attempts/$AID/report" | jq -r '.attempt.pendingAi')" "$((N_FAILED - 1))"

echo
echo "== 凑不够题：说清是哪一部分、差几道，不是 500 =="
SA=$(one "SELECT question_id FROM questions WHERE course_code = 'biochem-main' AND question_type = 'short_answer' ORDER BY question_id LIMIT 1;")
SA_N=$(jq -r '.items[] | select(.label == "问答题") | .questionCount' "$TPL_JSON")
exec_sql "UPDATE questions SET retired_at = datetime('now'), status = '草稿' WHERE question_id = '$SA';"
CODE=$(curl -s -o "$WORK/short.json" -w '%{http_code}' -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"biochem-main"}')
check "停用一道问答之后组卷：422，点名问答题、只有 $((SA_N - 1)) 道、要 $SA_N 道" \
  "$CODE/$(jq -r '.message' "$WORK/short.json" | grep -c "问答题.*只有 $((SA_N - 1)) 道，模板要 $SA_N 道")" "422/1"
READY=$(adm "$BASE/admin/bank/exam-readiness")
check "组卷体检也说凑不够，问答题 $((SA_N - 1))/$SA_N" \
  "$(echo "$READY" | jq -r '.courses[] | select(.courseCode == "biochem-main") | "\(.ready)/" + ([.parts[] | select(.label == "问答题") | "\(.available)/\(.required)"] | join(""))')" \
  "false/$((SA_N - 1))/$SA_N"
exec_sql "UPDATE questions SET retired_at = NULL, status = '已发布' WHERE question_id = '$SA';"
READY=$(adm "$BASE/admin/bank/exam-readiness")
check "恢复之后体检：能组，每部分可选题数 = 库里已发布的这类题数" \
  "$(echo "$READY" | jq -r '.courses[] | select(.courseCode == "biochem-main") | "\(.ready)/" + ([.parts[] | "\(.label)=\(.available)"] | join(","))')" \
  "true/$(jq -r '[.items | sort_by(.ord)[] | .label] | join(" ")' "$TPL_JSON" | tr ' ' '\n' | while read -r L; do
      T=$(jq -r --arg l "$L" '.items[] | select(.label == $l) | .filter.questionTypes | map("'"'"'" + . + "'"'"'") | join(",")' "$TPL_JSON")
      printf '%s=%s\n' "$L" "$(one "SELECT COUNT(*) FROM questions WHERE course_code = 'biochem-main' AND status = '已发布' AND retired_at IS NULL AND question_type IN ($T);")"
    done | paste -sd, -)"
check "英语那门课也在体检里，能组" \
  "$(echo "$READY" | jq -r '[.courses[] | select(.courseCode == "13000")] | length')" "1"

echo
echo "== 第二张卷：整章都考过了，提示可能重复（提示不是报错） =="
GEN2=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"biochem-main"}')
check "组得出来" "$(echo "$GEN2" | jq -r '.questionCount')" "$WANT_N"
check "每一部分都提示可能重复" \
  "$(echo "$GEN2" | jq -r '[.warnings[] | select(test("本次可能重复"))] | length')" "$(jq -r '.items | length' "$TPL_JSON")"

echo
echo "== 第二张卷交上去：多空题错了一空，错题本和 AI 错题分析看得懂（2026-10-07） =="
# 以前：多空题的答案逐空存在得分单元里、questions.answer 是空的，错题本「正确答案」一栏空着、
# 「你的答案」是一串 {"1":"…"}；AI 错题分析拿到的正确答案也是空的，只能自己猜答案再写分析。
# q06：第 1、2 空是候选池（含硫氨基酸，任填、顺序不限），第 3 空是"硫化氢"（也认 H2S）。
# 这张卷客观题照题库全答对，只有 q06 第 2 空填错，主观题都不写——错题本里只会有 q06 一道，
# 错题分析一定轮得到它（一次最多分析 20 道，错题多了轮不轮得到它全看顺序）。
AID2=$(echo "$GEN2" | jq -r '.attemptId')
WQ=biochem-ch01-q06
POOL6=$(jq -r --arg q "$WQ" '.sections[].questions[] | select(.questionId == $q) | .items[] | select(.params.pool) | .params.pool | join("、")' "$BANK_JSON")
REQ6=$(jq -r --arg q "$WQ" '.sections[].questions[] | select(.questionId == $q) | .items[] | select(.params.pool) | .params.requiredCount' "$BANK_JSON")
ANS6_3=$(jq -r --arg q "$WQ" '.sections[].questions[] | select(.questionId == $q) | .items[] | select(.ord == 3) | .answer' "$BANK_JSON")
# 池子里的第二个填在第 1 空：顺序不限，算对。（"、"是多字节字符，tr / cut 按字节切会切坏，一律用 jq）
P6_1=$(jq -rn --arg p "$POOL6" '$p | split("、")[1]')
check "（前提）q06 的候选池有 2 个、要填 2 个，第 3 空的答案是硫化氢" \
  "$(jq -rn --arg p "$POOL6" '$p | split("、") | length')/$REQ6/$ANS6_3" "2/2/硫化氢"
sql "SELECT aq.question_id AS qid, q.question_type AS qt, q.answer
       FROM attempt_questions aq JOIN questions q ON q.question_id = aq.question_id
      WHERE aq.attempt_id = '$AID2' ORDER BY aq.ord;" | jq '.[0].results' > "$WORK/paper2.json"
node - "$WORK/paper2.json" "$WORK/items.json" "$WQ" "$P6_1" > "$WORK/answers2.tsv" <<'NODE'
const fs = require('fs');
const paper = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const items = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const [wq, p1] = [process.argv[4], process.argv[5]];
for (const q of paper) {
  const its = items.filter((it) => it.qid === q.qid);
  let a = null;
  if (q.qid === wq) a = JSON.stringify({ 1: p1, 2: '赖氨酸', 3: 'H2S' });
  else if (q.qt === 'single_choice') a = q.answer;
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
  }
  if (a !== null) process.stdout.write(`${q.qid}\t${Buffer.from(a).toString('base64')}\n`);
}
NODE
while IFS=$'\t' read -r qid a64; do
  curl -s -o /dev/null -X PUT "$BASE/attempts/$AID2/answers" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d "$(jq -n --arg q "$qid" --arg v "$(printf '%s' "$a64" | base64 -d)" '{questionId:$q,answer:$v}')"
done < "$WORK/answers2.tsv"
curl -s -o /dev/null -X POST "$BASE/attempts/$AID2/submit" -H "Authorization: Bearer $STU"
check "（前提）这张卷只有 q06 一道客观题错了" \
  "$(one "SELECT group_concat(question_id) FROM answer_records WHERE attempt_id = '$AID2' AND is_correct = 0;")" "$WQ"
curl -s -o /dev/null -X POST "$BASE/ai/attempts/$AID2/run" -H "Authorization: Bearer $STU"
WB=$(au "$BASE/wrongbook?courseCode=biochem-main" | jq -c --arg q "$WQ" '.items[] | select(.questionId == $q)')
check "错题本里的正确答案：候选池的 2 个和第 3 空的硫化氢都在（以前是空的）" \
  "$(echo "$WB" | jq -r --arg p "$POOL6" --arg a "$ANS6_3" '.answerKeyText // "" | [contains($p | split("、")[0]), contains($p | split("、")[1]), contains($a)] | map(select(.)) | length')" "3"
check "  并且说清第 1、2 空顺序不限" "$(echo "$WB" | jq -r '.answerKeyText // "" | test("第 1、2 空（顺序不限）")')" "true"
check "错题本里的「你的答案」逐空写出来、标出错的是第 2 空（以前是一串 {\"1\":…}）" \
  "$(echo "$WB" | jq -r '.lastAnswerText // .lastAnswer')" "第 1 空：${P6_1}（对）；第 2 空：赖氨酸（错）；第 3 空：H2S（对）"
WSTEM=$(one "SELECT stem FROM questions WHERE question_id = '$WQ';")
WPROMPT=$(curl -s "$STUB/last-prompt" | jq -r --arg s "$WSTEM" '[.prompts[] | select(contains("分析学生这道题做错的原因") and contains($s))][-1] // ""')
check "（前提）替身收到了 q06 的错题分析请求" "$( [ -n "$WPROMPT" ] && echo 收到 || echo 没收到)" "收到"
WKEY=$(printf '%s\n' "$WPROMPT" | grep '^正确答案：' | head -1)
check "喂给 AI 的正确答案不是空的：候选池的 2 个和硫化氢都在（以前这一行是空的，模型只能自己猜）" \
  "$(for w in $(jq -rn --arg p "$POOL6" '$p | split("、") | join(" ")') "$ANS6_3"; do printf '%s' "$WKEY" | grep -cF "$w"; done | paste -sd/)" "1/1/1"
WUSR=$(printf '%s\n' "$WPROMPT" | grep '^学生答案：' | head -1)
check "喂给 AI 的学生答案逐空写、标出错的那一空，不是 JSON 代码" \
  "$(printf '%s' "$WUSR" | grep -cF '第 2 空：赖氨酸（错）')/$(printf '%s' "$WUSR" | grep -cF '{"')" "1/0"
REP2=$(au "$BASE/attempts/$AID2/report")
check "报告里 q06 带着候选池：可填哪几个、要填几个（以前候选池的空答错了不给答案）" \
  "$(echo "$REP2" | jq -r --arg q "$WQ" '.sections[].questions[] | select(.questionId == $q) | .answerKey // [] | .[] | select(.kind == "POOL") | "\(.values | join("、"))/\(.required)"')" "$POOL6/$REQ6"

echo
echo "== 练习：要 AI 判的题，练习里如实说不判分 =="
PST=$(curl -s -X POST "$BASE/practice/start" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"biochem-main","sectionTypes":["名词解释"]}')
PID=$(echo "$PST" | jq -r '.attemptId')
NX=$(au "$BASE/practice/$PID/next")
PQ=$(echo "$NX" | jq -r '.question.questionId')
check "名词解释出题时带着控件：大文本框（以前前端当选择题渲染，选项是空的，整页白屏）" \
  "$(echo "$NX" | jq -r '.question | "\(.questionType)/\(.inputWidget)/\(.options)"')" "term_explain/textarea/null"
ANS=$(curl -s -X POST "$BASE/practice/$PID/answer" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d "$(jq -n --arg q "$PQ" '{questionId:$q,answer:"练习时写的一段话"}')")
check "交上去：自己对照、不判对错（以前前端显示\"答错了\"）" \
  "$(echo "$ANS" | jq -r '"\(.selfCheck)/\(.isCorrect)"')" "true/null"
check "  参考答案就是这道题的采分点，条数和库里一样" \
  "$(echo "$ANS" | jq -r '[.items[] | select(.kind == "SCORE_POINT")] | length')" \
  "$(one "SELECT COUNT(*) FROM question_items WHERE question_id = '$PQ' AND item_kind = 'SCORE_POINT';")"
check "  已答算上它、正确率的分母不算它" \
  "$(au "$BASE/practice/$PID" | jq -r '.stats | "\(.answered)/\(.graded)"')" "1/0"

echo
echo "== 采分点：学员做过的题只能改文字和权重，不能增删（2026-10-07） =="
# 作答记录里的逐点结果按采分点序号记，删一个点、旧报告就对不上了
DONE_Q=$(qid_of '【全对】')
DN=$(one "SELECT COUNT(*) FROM question_items WHERE question_id = '$DONE_Q';")
LOCK=$(curl -s -X PATCH "$BASE/admin/bank/questions/$DONE_Q" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"removeItems":[1]}')
check "学员做过的名词解释：删采分点被拒，说清可以改文字和权重" \
  "$(echo "$LOCK" | jq -r '.error')/$(echo "$LOCK" | jq -r '.message' | grep -c '改文字、改权重可以')" "item_structure_locked/1"
check "  一个点都没少" "$(one "SELECT COUNT(*) FROM question_items WHERE question_id = '$DONE_Q';")" "$DN"
W0=$(one "SELECT printf('%g', weight) FROM question_items WHERE question_id = '$DONE_Q' AND item_ord = 1;")
check "  改权重可以" \
  "$(curl -s -X PATCH "$BASE/admin/bank/questions/$DONE_Q" -H "Authorization: Bearer $ADMIN" \
      -H 'Content-Type: application/json' -d '{"items":[{"ord":1,"weight":3}]}' | jq -r '.ok')/$(one "SELECT printf('%g', weight) FROM question_items WHERE question_id = '$DONE_Q' AND item_ord = 1;")" "true/3"
exec_sql "UPDATE question_items SET weight = $W0 WHERE question_id = '$DONE_Q' AND item_ord = 1;"

echo
echo "== 标准答案自检：判分器读不懂的答案，确认、发布、看板都拦得住（2026-10-07） =="
# 第 1 章 q04 第 3 空是受限选择（高 / 低），答案"低"。把它的枚举改成不含"低"——这就是 2026-10-04 那类事：
# 答案在、也确认了，判分器却判不出来，学员一交答案就 500。以前确认、发布、看板一道都拦不住。
EQ=biochem-ch01-q04
STATS0=$(adm "$BASE/admin/bank/stats")
check "（前提）看板：已发布的题全都判得出满分（第 1 章 $FILE_N 道整章发布、真实的题库数据）" \
  "$(echo "$STATS0" | jq -r '.publishedUngradable')" "0"
EP=$(one "SELECT params FROM question_items WHERE question_id = '$EQ' AND item_ord = 3;")
check "（前提）q04 第 3 空的枚举是高 / 低、答案是低" \
  "$(echo "$EP" | jq -c '.enum')/$(one "SELECT answer FROM question_items WHERE question_id = '$EQ' AND item_ord = 3;")" '["高","低"]/低'
exec_sql "UPDATE question_items SET params = '{\"enum\":[\"高\",\"中\"]}' WHERE question_id = '$EQ' AND item_ord = 3;"
STATS1=$(adm "$BASE/admin/bank/stats")
check "看板：已发布却判不出满分的 1 道，点名 q04、说出答案不在枚举里" \
  "$(echo "$STATS1" | jq -r '"\(.publishedUngradable)/" + ([.publishedUngradableSample[] | select(.questionId == "'$EQ'") | .problems[] | select(test("不在枚举"))] | length | tostring)')" "1/1"
exec_sql "UPDATE questions SET answer_state = '待核', status = '草稿' WHERE question_id = '$EQ';"
CF=$(curl -s -X PATCH "$BASE/admin/bank/questions/$EQ" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"answerState":"已确认"}')
check "确认不了，说清是哪一空、为什么" \
  "$(echo "$CF" | jq -r '.error')/$(echo "$CF" | jq -r '.message' | grep -c '确认不了.*#3.*不在枚举')" "answer_key_unusable/1"
check "  库里还是待核" "$(one "SELECT answer_state FROM questions WHERE question_id = '$EQ';")" "待核"
# 绕过确认那道关（直接改库，相当于从种子或别的入口进来的），整卷发布那道关也要拦住
exec_sql "UPDATE questions SET answer_state = '已确认' WHERE question_id = '$EQ';"
PB=$(curl -s -X POST "$BASE/admin/bank/exams/biochem-ch01/publish" -H "Authorization: Bearer $ADMIN")
check "整卷发布被拒，点名第 4 题" \
  "$(echo "$PB" | jq -r '.error')/$(echo "$PB" | jq -r '[.problems[] | select(test("^第4题"))] | length')" "answer_key_unusable/1"
check "  q04 没被发出去" "$(one "SELECT status FROM questions WHERE question_id = '$EQ';")" "草稿"
# 改回来：枚举是高 / 低。这时单题发布照常
exec_sql "UPDATE question_items SET params = '$EP' WHERE question_id = '$EQ' AND item_ord = 3;"
PQ=$(curl -s -X PATCH "$BASE/admin/bank/questions/$EQ" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"status":"已发布"}')
check "改好之后单题发布照常" "$(echo "$PQ" | jq -r '.ok // .message')/$(one "SELECT status FROM questions WHERE question_id = '$EQ';")" "true/已发布"
check "看板又是 0" "$(adm "$BASE/admin/bank/stats" | jq -r '.publishedUngradable')" "0"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
