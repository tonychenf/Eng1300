#!/usr/bin/env bash
# N4 英语迁入：行为一致性验证（需求文档 §13.1 的五条、验收 A4）。
#
# 要证明的是一句话：**加了学科层与能力包之后，英语的行为与蓝本完全一致。**
#
# 证明这件事需要一个与新实现**不同源**的参照物——拿新实现去对新实现是恒等式。
# 参照物是 test/blueprint-reference.mjs，里面冻着蓝本改造前的三段逻辑
# （判分、作文加权、掌握度分档）。那个文件不跟着 src/ 改，一改这组对比就废了。
#
# 分工：
#   normalizers.test.mjs  证明**折叠规则**逐字未变（29 组拼写对 + 九条非等价用例）
#   本文件                证明**端到端结果**未变：真实题库、真实接口、真实作答，
#                         把系统判出来的对错拿去和蓝本实现逐题比
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8789          # 端口表见 CLAUDE.md
STUB_PORT=8897
BASE="http://localhost:$PORT/api"
REF="node test/blueprint-reference.mjs"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
sql()  { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one()  { sql "$1" | jq -r '.[0].results[0] | to_entries[0].value // empty'; }
au()   { curl -s -H "Authorization: Bearer $STU" "$@"; }

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -9 -- "-$SERVER_PGID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$ROOT_DIR/.wrangler"; rm -f "$ROOT_DIR/.dev.vars"
}
trap cleanup EXIT

[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-n4
SETUP_TOKEN=test-setup-n4
ENCRYPTION_KEY=test-encryption-key-n4
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "找不到 $EXAM 的种子，先跑 node scripts/build-seed-sql.mjs"; exit 1; }
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

node test/ai-stub.mjs "$STUB_PORT" >/tmp/n4-stub.log 2>&1 &
STUB_PID=$!

echo "== 启动服务 =="
DEV_LOG=/tmp/n4-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1; done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }
echo "  服务已就绪"

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-n4' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin12345"}' | jq -r '.token')
curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg u "http://127.0.0.1:$STUB_PORT/v1" '{baseUrl:$u,apiKey:"k",model:"m",protocol:"openai"}')"
PW=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"N401","subjects":["english"]}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$PW" '{username:"N401",password:$p}')" | jq -r '.token')
[ "$STU" != "null" ] && [ -n "$STU" ] || { echo "学员登录失败"; exit 1; }
SID=$(one "SELECT id FROM users WHERE username='N401';")

echo
echo "== §13.1-④ 组卷产出的卷子结构与蓝本一致 =="
AID=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"13000"}' | jq -r '.attemptId')
[ "$AID" != "null" ] && [ -n "$AID" ] || { echo "组卷失败"; exit 1; }
PAPER=$(au "$BASE/attempts/$AID")
check "七个部分"   "$(echo "$PAPER" | jq -r '.sections | length')" "7"
check "51 道题"    "$(echo "$PAPER" | jq -r '[.sections[].questions[]] | length')" "51"
# 卷面总分从各题分值现加，不从响应里那个可能不存在的字段取——
# 原来写成 `.totalScore // 100`，字段不存在时也会算通过，是条恒真断言。
check "卷面总分 100" "$(one "SELECT SUM(score_per_question) FROM attempt_questions WHERE attempt_id='$AID';")" "100"
check "限时 150 分钟" "$(echo "$PAPER" | jq -r '.attempt.timeLimitMinutes')" "150"
# 题型改名之后，卷子里不该再出现旧名字
check "卷面题型只有声明过的三种" \
  "$(echo "$PAPER" | jq -r '[.sections[].questions[].questionType] | unique | sort | join(",")')" \
  "essay,fill_text,single_choice"

echo
echo "== §13.1-① 同一份作答，新旧判分逐题一致 =="
# 每道题按序号轮换四种作答，把基础折叠的几条路都走到：
#   原样 / 全大写 / 带尾点 / 明显错答
# 作文单独给一段文字。折叠规则本身由 normalizers.test.mjs 逐字证明，这里证的是端到端。
sql "SELECT aq.ord, q.question_id, q.question_type, q.answer
       FROM attempt_questions aq JOIN questions q ON q.question_id = aq.question_id
      WHERE aq.attempt_id = '$AID' ORDER BY aq.ord" \
  | jq -r '.[0].results[] | @base64' > /tmp/n4-qs
ESSAY_TEXT="Online shopping is very popular now. I think it is convenient and cheap."
i=0
while read -r line; do
  row=$(echo "$line" | base64 -d)
  qid=$(echo "$row" | jq -r '.question_id'); qt=$(echo "$row" | jq -r '.question_type')
  ans=$(echo "$row" | jq -r '.answer // ""')
  if [ "$qt" = "essay" ]; then a="$ESSAY_TEXT"; else
    case $((i % 4)) in
      0) a="$ans" ;;
      1) a=$(printf '%s' "$ans" | tr '[:lower:]' '[:upper:]') ;;
      2) a="${ans}." ;;
      3) a="ZZZ" ;;
    esac
    i=$((i+1))
  fi
  curl -s -o /dev/null -X PUT "$BASE/attempts/$AID/answers" -H "Authorization: Bearer $STU" \
    -H 'Content-Type: application/json' -d "$(jq -n --arg q "$qid" --arg v "$a" '{questionId:$q,answer:$v}')"
done < /tmp/n4-qs
curl -s -o /dev/null -X POST "$BASE/attempts/$AID/submit" -H "Authorization: Bearer $STU"

# 系统判出来的对错 vs 蓝本实现重算的对错，逐题比
sql "SELECT q.question_type || char(9) || COALESCE(q.answer,'') || char(9)
          || COALESCE(r.user_answer,'') || char(9) || aq.score_per_question || char(9)
          || COALESCE(CAST(r.is_correct AS TEXT),'') AS row
       FROM attempt_questions aq
       JOIN questions q ON q.question_id = aq.question_id
       LEFT JOIN answer_records r ON r.attempt_id = aq.attempt_id AND r.question_id = aq.question_id
      WHERE aq.attempt_id = '$AID' ORDER BY aq.ord" \
  | jq -r '.[0].results[].row' > /tmp/n4-cmp
CMP=$($REF batch < /tmp/n4-cmp 2>&1); CMP_RC=$?
echo "$CMP" | grep -v '^比对' | sed 's/^/     /' | head -8
CMP_N=$(echo "$CMP" | grep -oE '比对 [0-9]+ 行' | grep -oE '[0-9]+')
# 前置确认：真的比到了整卷，不是比了个空
check "逐题比对覆盖了全部 51 道题" "$CMP_N" "51"
check "51 道题的判分与蓝本完全一致" "$CMP_RC" "0"
# 客观题里对错都要有，否则"一致"可能只是因为全对或全错
OBJ_OK=$(one "SELECT COUNT(*) FROM answer_records WHERE attempt_id='$AID' AND is_correct=1;")
OBJ_NG=$(one "SELECT COUNT(*) FROM answer_records WHERE attempt_id='$AID' AND is_correct=0;")
check "这份作答里判对的和判错的都有（不是全对或全错）" \
  "$([ "${OBJ_OK:-0}" -gt 0 ] && [ "${OBJ_NG:-0}" -gt 0 ] && echo yes || echo no)" "yes"
echo "     （判对 $OBJ_OK 题，判错 $OBJ_NG 题）"

echo
echo "== §13.1-② 同一组 AI 返回，作文得分与蓝本一致 =="
# 替身对作文固定返回 content=5 language=4 vocabulary=4.5 coherence=5 length=6
curl -s -o /dev/null -X POST "$BASE/ai/attempts/$AID/run" -H "Authorization: Bearer $STU"
GOT=$(au "$BASE/attempts/$AID/report" | jq -r '[.sections[].questions[] | select(.questionType=="essay")][0].aiScore // empty')
[ -n "$GOT" ] || GOT=$(one "SELECT ai_score FROM answer_records r JOIN questions q ON q.question_id=r.question_id
                             WHERE r.attempt_id='$AID' AND q.question_type='essay';")
WANT=$($REF essay 5 4 4.5 5 6)
check "作文得分与蓝本加权公式一致（$WANT 分）" "$GOT" "$WANT"
# 前置确认：这个分不是 0 也不是满分，否则"一致"可能是两边都没算
check "作文得分落在 0 与 30 之间（说明确实算了）" \
  "$(awk -v s="$GOT" 'BEGIN{print (s>0 && s<30) ? 1 : 0}')" "1"

echo
echo "== §13.1-③ 掌握度分档与蓝本一致 =="
# 构造覆盖各档边界的记录，逐条拿系统的档位去对蓝本算出来的档位
TAGS=$(sql "SELECT tag_id FROM knowledge_points WHERE subject_id=(SELECT subject_id FROM subjects WHERE code='english') ORDER BY tag_id LIMIT 6" | jq -r '.[0].results[].tag_id')
CASES="0 0 0 null|3 0 3 correct|2 0 2 correct|1 3 0 wrong|3 1 1 correct|1 1 1 correct"
idx=0; MIS=0; COVERED=""
sql "DELETE FROM user_knowledge_mastery WHERE user_id=$SID" >/dev/null 2>&1
while IFS= read -r tag; do
  c=$(echo "$CASES" | cut -d'|' -f$((idx+1)))
  set -- $c
  npx wrangler d1 execute "$D1_NAME" --local --command \
    "INSERT OR REPLACE INTO user_knowledge_mastery
       (user_id, course_code, tag_id, correct_count, wrong_count, consecutive_correct, last_result)
     VALUES ($SID,'13000','$tag',$1,$2,$3,$([ "$4" = null ] && echo NULL || echo "'$4'"))" >/dev/null 2>&1
  idx=$((idx+1))
done <<< "$TAGS"
REPORT=$(curl -s -H "Authorization: Bearer $ADMIN" "$BASE/admin/stats/students/$SID")
idx=0
while IFS= read -r tag; do
  c=$(echo "$CASES" | cut -d'|' -f$((idx+1))); set -- $c
  name=$(one "SELECT name FROM knowledge_points WHERE tag_id='$tag';")
  got=$(echo "$REPORT" | jq -r --arg n "$name" '.mastery[] | select(.name==$n) | .tier')
  want=$($REF tier "$1" "$2" "$3" "$4")
  COVERED="$COVERED $want"
  [ "$got" = "$want" ] || { MIS=$((MIS+1)); echo "     不一致｜$name 蓝本=$want 系统=$got"; }
  idx=$((idx+1))
done <<< "$TAGS"
check "六种边界情形的档位与蓝本完全一致" "$MIS" "0"
# 前置确认：这六条真的落在不同档位上。六条都落在同一档的话，"完全一致"
# 只说明两边都会算那一档，说明不了分档逻辑没漂。
TIERS_N=$(echo $COVERED | tr ' ' '\n' | sort -u | grep -c .)
echo "     （覆盖档位：$(echo $COVERED | tr ' ' '\n' | sort -u | tr '\n' ' ')）"
check "至少覆盖三个不同档位" "$([ "$TIERS_N" -ge 3 ] && echo yes || echo no)" "yes"

echo
echo "== 学科层没有把英语变成「特殊的那个」 =="
# 英语现在只是第一个学科：数据在 data/subjects/english/，题型在能力包里声明
check "英语的数据目录与生化同构" \
  "$([ -d ../data/subjects/english/groups ] && [ -f ../data/subjects/english/knowledge-points.json ] && echo yes || echo no)" "yes"
check "两个学科的填空题型码统一为 fill_text" \
  "$(one "SELECT COUNT(DISTINCT s.code) FROM subject_question_types t JOIN subjects s ON s.subject_id=t.subject_id WHERE t.type_code='fill_text';")" "2"
check "库里没有残留的旧题型码" \
  "$(one "SELECT COUNT(*) FROM subject_question_types WHERE type_code IN ('fill_blank_transform','fill_blank');")" "0"
check "题面里也没有残留的旧题型码" \
  "$(one "SELECT COUNT(*) FROM questions WHERE question_type='fill_blank_transform';")" "0"
# 内容里出现的题型，必须都在该学科声明过——否则发布会被 N3 那道门拦下
check "英语题库用到的题型都已声明" \
  "$(one "SELECT COUNT(*) FROM questions q WHERE q.subject_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM subject_question_types t
             WHERE t.subject_id = q.subject_id AND t.type_code = q.question_type);")" "0"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
