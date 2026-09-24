#!/usr/bin/env bash
# 多单元作答控件的浏览器检查：备库 → 起服务 → 开一份卷 → 给第一道题挂三个空 → 跑用例。
#
# 卷子和"哪道题有空"在这里准备好再传给浏览器用例。让用例自己去页面上找一道多空题
# 是靠猜，猜错了它会在一道普通填空题上全绿。
set -uo pipefail
cd "$(dirname "$0")/.."

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8786          # 端口表见 CLAUDE.md。不用 8787：那是 wrangler dev 的默认端口
BASE="http://127.0.0.1:$PORT/api"

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -- -"$SERVER_PGID" 2>/dev/null
  rm -f .dev.vars
}
trap cleanup EXIT

if [ ! -d public ]; then
  echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1
fi

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-uiitems
SETUP_TOKEN=test-setup-uiitems
ENCRYPTION_KEY=test-encryption-key-uiitems
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 启动服务 =="
DEV_LOG=/tmp/ui-items-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1
done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

echo "== 账号与卷子 =="
curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-uiitems' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
UI_PASS=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"UI501","subjects":["english"]}' | jq -r '.initialPassword')
[ -n "$UI_PASS" ] && [ "$UI_PASS" != null ] || { echo "建学员账号失败"; exit 1; }
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$UI_PASS" '{username:"UI501",password:$p}')" | jq -r '.token')

ATTEMPT=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"13000"}' | jq -r '.attemptId')
[ -n "$ATTEMPT" ] && [ "$ATTEMPT" != null ] || { echo "组卷失败"; exit 1; }

sql() { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one() { sql "$1" | jq -r '.[0].results[0] // {} | to_entries[0].value // empty'; }
# 挑一道**填空题**来挂空，不能随手挑第一题。
# 第一题是阅读判断（single_choice），它的归一化器是 choice——只保留 A–Z，中文答案
# 折完是空串，三个空一律判错，而判分不会报任何错。控件是渲染出来了，但这套用例
# 测到的就只剩"三个框都标红"，证明不了逐空判定是对的。
# 决定可达性的属性是题型，所以下面把它打印出来。
QID=$(one "SELECT aq.question_id FROM attempt_questions aq JOIN questions q ON q.question_id=aq.question_id
           WHERE aq.attempt_id='$ATTEMPT' AND q.question_type='fill_text' ORDER BY aq.ord LIMIT 1;")
[ -n "$QID" ] || { echo "本卷里没有填空题，挂不了空"; exit 1; }
QORD=$(one "SELECT ord FROM attempt_questions WHERE attempt_id='$ATTEMPT' AND question_id='$QID';")
QSEC=$(one "SELECT section_ord FROM attempt_questions WHERE attempt_id='$ATTEMPT' AND question_id='$QID';")
QTYPE=$(one "SELECT question_type FROM questions WHERE question_id='$QID';")
QNORM=$(one "SELECT normalizers FROM subject_question_types WHERE type_code='$QTYPE'
             AND subject_id=(SELECT subject_id FROM subjects WHERE code='english');")
echo "  挂空的题：第 $QORD 题（第 $QSEC 部分），题型 $QTYPE，归一化器 $QNORM"
ENG=$(one "SELECT subject_id FROM subjects WHERE code='english';")
for i in 1 2 3; do
  npx wrangler d1 execute "$D1_NAME" --local --command \
    "INSERT OR REPLACE INTO question_items (question_id, item_ord, subject_id, item_kind, answer, weight)
     VALUES ('$QID', $i, $ENG, 'BLANK', '第${i}空标准答案', 1);" >/dev/null 2>&1
done
N=$(one "SELECT COUNT(*) FROM question_items WHERE question_id='$QID';")
[ "$N" = "3" ] || { echo "挂空失败，只挂上了 $N 个"; exit 1; }

echo "== 浏览器检查 =="
UI_BASE="http://127.0.0.1:$PORT" UI_USER=UI501 UI_PASS="$UI_PASS" \
  UI_ATTEMPT="$ATTEMPT" UI_ORD="$QORD" UI_SECTION="$QSEC" \
  UI_ANSWERS='["第1空标准答案","第2空标准答案","第3空标准答案"]' \
  node test/ui-multi-blank.mjs
