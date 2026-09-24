#!/usr/bin/env bash
# N6b：后台上传原始资料 → Worker 里解析 → 只留解析结果。
#
# 这一套必须在**真的 Worker 里**跑：解压走的是 DecompressionStream，
# 而命令行那条路走的是同一份代码但在 Node 里——两边同源不代表 workerd 也跑得通
# （CPU 时间、流的行为都可能不一样）。拿 Node 测等于没测这件事。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8780          # 端口表见 CLAUDE.md
BASE="http://127.0.0.1:$PORT/api"
DOCX="$ROOT_DIR/../data/subjects/biochem/source/第01章-蛋白质的化学.docx"
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
sql() { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one() { sql "$1" | jq -r '.[0].results[0] // {} | to_entries[0].value // empty'; }
exec_sql() { npx wrangler d1 execute "$D1_NAME" --local --command "$1" >/dev/null 2>&1; }

cleanup() {
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$ROOT_DIR/.wrangler"; rm -f "$ROOT_DIR/.dev.vars"
}
trap cleanup EXIT

[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }
[ -f "$DOCX" ] || { echo "找不到样本 docx：$DOCX"; exit 1; }

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-n6b
SETUP_TOKEN=test-setup-n6b
ENCRYPTION_KEY=test-encryption-key-n6b
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done

echo "== 启动服务 =="
DEV_LOG=/tmp/n6b-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-n6b' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin12345"}' | jq -r '.token')
[ -n "$ADMIN" ] && [ "$ADMIN" != null ] || { echo "管理员登录失败"; exit 1; }
up() {  # 参数：查询串
  curl -s -X POST "$BASE/admin/bank/import?$1" -H "Authorization: Bearer $ADMIN" \
    -H 'Content-Type: application/octet-stream' --data-binary "@$DOCX"
}
Q='subjectCode=biochem&groupId=biochem-ch01&label=%E7%AC%AC01%E7%AB%A0&orderKey=1&filename=ch01.docx'

echo
echo "== 参数不对就当场拒，并说清楚是什么 =="
check "缺 subjectCode" "$(up 'groupId=x1&label=a&orderKey=1' | jq -r '.error')" "invalid_request"
check "内容组 id 不合法" "$(up 'subjectCode=biochem&groupId=Ch_01&label=a&orderKey=1' | jq -r '.error')" "invalid_group_id"
check "缺 orderKey" "$(up 'subjectCode=biochem&groupId=x1&label=a' | jq -r '.error')" "invalid_order_key"
check "orderKey 不给默认值（报错点名这个字段）" \
  "$(up 'subjectCode=biochem&groupId=x1&label=a' | jq -r '.message' | grep -c orderKey)" "1"
check "学科不存在" "$(up 'subjectCode=nosuch&groupId=x1&label=a&orderKey=1' | jq -r '.error')" "subject_not_found"
check "学科的管线没实现（英语是 pdf-ocr-llm）" \
  "$(up 'subjectCode=english&groupId=x1&label=a&orderKey=1' | jq -r '.error')" "pipeline_not_implemented"
check "空 body" \
  "$(curl -s -X POST "$BASE/admin/bank/import?$Q" -H "Authorization: Bearer $ADMIN" | jq -r '.error')" "empty_body"
check "不是 zip 的文件" \
  "$(curl -s -X POST "$BASE/admin/bank/import?$Q" -H "Authorization: Bearer $ADMIN" \
     --data-binary 'this is not a docx' | jq -r '.error')" "bad_zip"
check "未登录传不进来" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/bank/import?$Q" --data-binary "@$DOCX")" "401"

echo
echo "== 试解析（dryRun）：出结果但不落库 =="
DRY=$(up "$Q&dryRun=1")
check "dryRun 成功" "$(echo "$DRY" | jq -r '.ok')" "true"
check "解析出 34 道题" "$(echo "$DRY" | jq -r '.questions')" "34"
check "解析出 50 个空" "$(echo "$DRY" | jq -r '.blanks')" "50"
check "四个题型分组都在" "$(echo "$DRY" | jq -r '.perSection | length')" "4"
check "原题有误的记录带上来了" \
  "$(echo "$DRY" | jq -r '[.parsingNotes[] | select(.kind == "原题有误")] | length')" "1"
check "提示了有多少题还没有考点" "$(echo "$DRY" | jq -r '.questionsWithoutTags')" "34"
check "dryRun 一行都没写进库" "$(one "SELECT COUNT(*) FROM exams WHERE exam_id='biochem-ch01';")" "0"

echo
echo "== 正式上传：落库，且原件不落盘 =="
UP=$(up "$Q")
check "上传成功" "$(echo "$UP" | jq -r '.ok')" "true"
check "内容组进库了" "$(one "SELECT COUNT(*) FROM exams WHERE exam_id='biochem-ch01';")" "1"
check "来源标成 UPLOAD" "$(one "SELECT origin FROM exams WHERE exam_id='biochem-ch01';")" "UPLOAD"
check "order_key 是传进去的章节号" "$(one "SELECT order_key FROM exams WHERE exam_id='biochem-ch01';")" "1"
check "34 道题都入库" "$(one "SELECT COUNT(*) FROM questions WHERE exam_id='biochem-ch01';")" "34"
check "50 个空都入库" \
  "$(one "SELECT COUNT(*) FROM question_items i JOIN questions q ON q.question_id=i.question_id WHERE q.exam_id='biochem-ch01' AND i.item_kind='BLANK';")" "50"
check "题全落在缺答案" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id='biochem-ch01' AND answer_state<>'缺答案';")" "0"
check "一道都不可抽（缺答案 + 未发布）" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id='biochem-ch01' AND status='已发布' AND answer_state='已确认';")" "0"
check "解析记录入库并区分了类型" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE exam_id='biochem-ch01' AND note_kind='原题有误';")" "1"
check "订正前后都留了痕" \
  "$(one "SELECT COUNT(*) FROM exam_parsing_notes WHERE exam_id='biochem-ch01' AND note_kind='原题有误' AND corrected_from IS NOT NULL AND corrected_to IS NOT NULL;")" "1"

echo
echo "== 只留纯文本，不留原件 =="
check "留了 85 段原文" "$(one "SELECT json_array_length(paragraphs) FROM content_group_sources WHERE exam_id='biochem-ch01';")" "85"
check "记了文件名与字节数" \
  "$(one "SELECT CASE WHEN filename IS NOT NULL AND byte_size > 0 THEN '有' ELSE '无' END FROM content_group_sources WHERE exam_id='biochem-ch01';")" "有"
check "记了是谁传的" "$(one "SELECT uploaded_by FROM content_group_sources WHERE exam_id='biochem-ch01';")" "admin"
# 反面：库里任何一个文本列都不该出现 docx 的魔数（PK\003\004）或 OOXML 的标志串。
# 只断"我们没写原件"是看代码，这里断的是**库里真的找不到原件的痕迹**。
check "库里没有 docx 的字节" \
  "$(one "SELECT COUNT(*) FROM content_group_sources WHERE paragraphs LIKE '%PK%' OR paragraphs LIKE '%word/document.xml%';")" "0"
check "原文段落读得回来" \
  "$(curl -s "$BASE/admin/bank/import/biochem-ch01/source" -H "Authorization: Bearer $ADMIN" | jq -r '.paragraphs | length')" "85"
check "没上传过的内容组没有留存" \
  "$(curl -s "$BASE/admin/bank/import/nosuch/source" -H "Authorization: Bearer $ADMIN" | jq -r '.error')" "not_found"

echo
echo "== 重复上传默认拒绝 =="
DUP=$(up "$Q")
check "同一个 id 再传一次被拒" "$(echo "$DUP" | jq -r '.error')" "group_exists"
check "拒绝时说得出它现在的来源" "$(echo "$DUP" | jq -r '.message' | grep -c UPLOAD)" "1"
check "被拒之后题数没变" "$(one "SELECT COUNT(*) FROM questions WHERE exam_id='biochem-ch01';")" "34"

echo
echo "== 服务还活着 =="
check "跑完之后服务还在" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/health")" "200"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
