#!/usr/bin/env bash
# N5b 富媒体题干：资源表、静态托管、喂 AI 前的替换（验收 G1 数据侧、G3、G10）。
#
# 标记切分、契约校验、判分口径在 test/rich-text.test.mjs 里用纯 node 测（测得细）；
# 界面渲染在 test/ui-rich.sh 里用真浏览器测。这一套只管中间那段：
# 文件有没有真被托管出去、接口有没有把资源带给前端、模型那头收到的题干长什么样。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8785          # 端口表见 CLAUDE.md
STUB_PORT=8896
BASE="http://127.0.0.1:$PORT/api"
PASS=0; FAIL=0
# 测试期间临时塞进 data/ 的资源目录，收摊时删掉
TMP_ASSET_DIR="$ROOT_DIR/../data/subjects/english/assets/n5b-probe"

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
stu()  { curl -s -H "Authorization: Bearer $STU" "$@"; }
stuj() { curl -s -H "Authorization: Bearer $STU" -H 'Content-Type: application/json' "$@"; }

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -9 -- "-$SERVER_PGID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$ROOT_DIR/.wrangler" "$TMP_ASSET_DIR" "$ROOT_DIR/public/bank/english/n5b-probe"
  rm -f "$ROOT_DIR/.dev.vars"
}
trap cleanup EXIT

if [ ! -d public ]; then
  echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1
fi

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-n5b
SETUP_TOKEN=test-setup-n5b
ENCRYPTION_KEY=test-encryption-key-n5b
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
# 四套：13000 的组卷模板要 10 题一篇的「段落大意与句子补全」，2015-04 那篇被扣下
# 一道存疑题只剩 9 道，凑不满。少导的话组卷直接失败，而失败信息看着像模板配错了。
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

echo
echo "== 资源表结构 =="
cols() { sql "SELECT group_concat(name) AS c FROM pragma_table_info('$1');" | jq -r '.[0].results[0].c // empty' | tr ',' '\n' | sort | tr '\n' ' '; }
for c in question_id asset_key subject_id kind path alt caption; do
  check "question_assets 有 $c 列" "$(cols question_assets | grep -cw "$c")" "1"
done
check "主键是 (题目, 资源名)" \
  "$(sql "SELECT group_concat(name) AS c FROM pragma_table_info('question_assets') WHERE pk > 0;" | jq -r '.[0].results[0].c')" \
  "question_id,asset_key"
# G10：图片不进 D1。真出现 blob/data 列说明图被塞进库里了
check "表上没有存字节的列" \
  "$(sql "SELECT COUNT(*) AS c FROM pragma_table_info('question_assets') WHERE lower(type) LIKE '%blob%';" | jq -r '.[0].results[0].c')" "0"

echo
echo "== 题库资源拷进静态托管目录（G10）=="
mkdir -p "$TMP_ASSET_DIR"
cp test/fixtures/n5b-good/assets/ch01/fig1.png "$TMP_ASSET_DIR/probe.png"
echo "这不是题目资源" > "$TMP_ASSET_DIR/notes.txt"
OUT=$(node ../scripts/build-bank-assets.mjs 2>&1)
check "拷贝脚本跑通" "$?" "0"
check "图片拷到了 public/bank/<学科码>/ 下" \
  "$([ -f public/bank/english/n5b-probe/probe.png ] && echo 有 || echo 无)" "有"
# 放进 public 的东西是公开可取的，所以只收题目资源该有的那几种格式
check "不是题目资源的文件没被端出去" \
  "$([ -f public/bank/english/n5b-probe/notes.txt ] && echo 有 || echo 无)" "无"
check "并且明说跳过了它" "$(echo "$OUT" | grep -c '跳过')" "1"
check "拷过去的字节与源文件一致" \
  "$(md5sum < public/bank/english/n5b-probe/probe.png)" "$(md5sum < "$TMP_ASSET_DIR/probe.png")"

echo "== 启动服务 =="
DEV_LOG=/tmp/n5b-dev.log
node test/ai-stub.mjs "$STUB_PORT" > /tmp/n5b-stub.log 2>&1 &
STUB_PID=$!
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }
echo "  服务已就绪"

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-n5b' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin12345"}' | jq -r '.token')
[ -n "$ADMIN" ] && [ "$ADMIN" != null ] || { echo "管理员登录失败"; exit 1; }
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d '{"username":"N5B1","password":"student12345","subjects":["english"]}'
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"N5B1","password":"student12345"}' | jq -r '.token')
[ -n "$STU" ] && [ "$STU" != null ] || { echo "学员登录失败"; exit 1; }
ENG=$(one "SELECT subject_id FROM subjects WHERE code='english';")

echo
echo "== 图片是被托管出去的，不是从库里读的 =="
IMG_HTTP=$(curl -s -o /tmp/n5b-img.png -w '%{http_code} %{content_type} %{size_download}' \
  "http://127.0.0.1:$PORT/bank/english/n5b-probe/probe.png")
check "图能取到" "$(echo "$IMG_HTTP" | cut -d' ' -f1)" "200"
# 只断 200 是不够的：[assets] 配了 not_found_handling=single-page-application，
# **取不到的路径会返回 index.html 而且也是 200**。所以要看类型和字节。
check "返回的是图片不是页面" "$(echo "$IMG_HTTP" | cut -d' ' -f2)" "image/png"
check "字节与源文件一致" "$(md5sum < /tmp/n5b-img.png)" "$(md5sum < "$TMP_ASSET_DIR/probe.png")"
MISS=$(curl -s -o /dev/null -w '%{http_code} %{content_type}' \
  "http://127.0.0.1:$PORT/bank/english/n5b-probe/nosuch.png")
check "不存在的图也回 200（SPA 回落，所以 200 什么都证明不了）" "$(echo "$MISS" | cut -d' ' -f1)" "200"
check "但它是一张 HTML 页面" "$(echo "$MISS" | cut -d' ' -f2 | grep -c 'text/html')" "1"

echo
echo "== 接口把资源带给前端（G1 的数据侧）=="
QID=$(one "SELECT question_id FROM questions WHERE course_code='13000' AND status='已发布' ORDER BY question_id LIMIT 1;")
exec_sql "INSERT OR REPLACE INTO question_assets (question_id, asset_key, subject_id, kind, path, alt, caption)
  VALUES ('$QID', 'fig1', $ENG, 'IMAGE', 'english/n5b-probe/probe.png', '一张用于测试的纯色方块图', '图 1 构造图');"
exec_sql "UPDATE questions SET stem = '下图 ![fig1] 是什么？行内公式 \$x^2\$ 一并渲染。' WHERE question_id='$QID';"
ATT=$(stuj -X POST "$BASE/exams/generate" -d '{"courseCode":"13000"}' | jq -r '.attemptId')
[ -n "$ATT" ] && [ "$ATT" != null ] || { echo "组卷失败"; exit 1; }
# 抽到的卷子未必含那道题，直接把它挂进这份卷子（换掉第一题）
exec_sql "UPDATE attempt_questions SET question_id='$QID' WHERE attempt_id='$ATT' AND ord=1
  AND NOT EXISTS (SELECT 1 FROM attempt_questions WHERE attempt_id='$ATT' AND question_id='$QID');"
PAPER=$(stu "$BASE/attempts/$ATT")
QJSON=$(echo "$PAPER" | jq -c --arg q "$QID" '[.sections[].questions[] | select(.questionId==$q)][0]')
check "作答页带上了这道题" "$(echo "$QJSON" | jq -r '.questionId')" "$QID"
check "带上了资源" "$(echo "$QJSON" | jq -r '.assets | length')" "1"
check "带上了 alt（要落到 <img alt> 上）" "$(echo "$QJSON" | jq -r '.assets[0].alt')" "一张用于测试的纯色方块图"
check "带上了路径" "$(echo "$QJSON" | jq -r '.assets[0].path')" "english/n5b-probe/probe.png"
check "没有图的题拿到空数组，不是 null" \
  "$(echo "$PAPER" | jq -r --arg q "$QID" '[.sections[].questions[] | select(.questionId!=$q)][0].assets | type')" "array"

echo
echo "== 发布校验拦住 alt 缺失的题（G2 的线上侧）=="
EX=$(one "SELECT exam_id FROM questions WHERE question_id='$QID';")
exec_sql "UPDATE question_assets SET alt='' WHERE question_id='$QID';"
CODE=$(admj -o /tmp/n5b-pub.json -w '%{http_code}' -X POST "$BASE/admin/bank/exams/$EX/publish")
check "alt 空着不让发布" "$CODE" "422"
check "错误码点名是资源契约" "$(jq -r '.error' /tmp/n5b-pub.json)" "asset_contract_failed"
check "并且说清楚是哪道题" "$(jq -r '.problems | join(" ")' /tmp/n5b-pub.json | grep -c '题')" "1"
exec_sql "UPDATE question_assets SET alt='一张用于测试的纯色方块图' WHERE question_id='$QID';"
CODE=$(admj -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/bank/exams/$EX/publish")
check "补上 alt 之后能发布" "$CODE" "200"

echo
echo "== 喂给模型的题干里 ![fig1] 换成了 [图：alt]（G3）=="
admj -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" \
  -d "$(jq -n --arg u "http://127.0.0.1:$STUB_PORT/v1" \
    '{baseUrl:$u,apiKey:"stub-key",model:"stub-model",protocol:"openai"}')"
# 造一条错题记录，然后跑错题分析——这是目前唯一会把题干发给模型的路径
stuj -o /dev/null -X PUT "$BASE/attempts/$ATT/answers" \
  -d "$(jq -n --arg q "$QID" '{questionId:$q,answer:"ZZZ"}')"
stu -o /dev/null -X POST "$BASE/attempts/$ATT/submit"
# 一份卷子五十道题，没作答的全算错，错题分析一次最多跑 20 条——那道带图的题
# 未必在里面。只留它一条，断言才断得准（而不是"碰巧抽到了"）。
exec_sql "DELETE FROM wrong_items WHERE last_attempt_id='$ATT' AND question_id <> '$QID';"
check "只留下那道带图的错题" \
  "$(one "SELECT COUNT(*) FROM wrong_items WHERE last_attempt_id='$ATT';")" "1"
stu -o /dev/null -X POST "$BASE/ai/attempts/$ATT/run"
# 看模型那头**收到过的所有**提示词：作文批改那条也会走同一个替身
PROMPT=$(curl -s "http://127.0.0.1:$STUB_PORT/last-prompt" | jq -r '.prompts | join("\n")')
check "模型确实收到了这道题" "$(echo "$PROMPT" | grep -c '下图')" "1"
check "收到的是 [图：alt]" "$(echo "$PROMPT" | grep -c '\[图：一张用于测试的纯色方块图\]')" "1"
check "不是原样的 ![fig1]" "$(echo "$PROMPT" | grep -c '!\[fig1\]')" "0"
check "公式原样保留（模型认识 LaTeX）" "$(echo "$PROMPT" | grep -c 'x\^2')" "1"

echo
echo "== G10：库里只有元数据，没有图的字节 =="
check "路径存的是相对路径，不是 data: 内联" \
  "$(one "SELECT COUNT(*) FROM question_assets WHERE path LIKE 'data:%' OR LENGTH(path) > 200;")" "0"
check "整张表的字节数远小于一张图" \
  "$([ "$(one "SELECT COALESCE(SUM(LENGTH(path)+LENGTH(COALESCE(alt,''))+LENGTH(COALESCE(caption,''))),0) FROM question_assets;")" -lt 500 ] && echo 小 || echo 大)" "小"
check "而那张图本身有几百字节" \
  "$([ "$(stat -c%s "$TMP_ASSET_DIR/probe.png")" -gt 100 ] && echo 有 || echo 无)" "有"

echo
check "跑完之后服务还活着" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/health")" "200"
echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
