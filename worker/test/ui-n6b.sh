#!/usr/bin/env bash
# 后台上传界面的浏览器实测（三种宽度）。
set -uo pipefail
cd "$(dirname "$0")/.."

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8779          # 端口表见 CLAUDE.md
STUB_PORT=8894
BASE="http://127.0.0.1:$PORT/api"
ROOT_DIR="$(pwd)"
DOCX="$ROOT_DIR/../data/subjects/biochem/source/第01章-蛋白质的化学.docx"

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -- -"$SERVER_PGID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$ROOT_DIR/.wrangler"; rm -f .dev.vars
}
trap cleanup EXIT

[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }
[ -f "$DOCX" ] || { echo "找不到样本 docx"; exit 1; }

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-uin6b
SETUP_TOKEN=test-setup-uin6b
ENCRYPTION_KEY=test-encryption-key-uin6b
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done

node test/ai-stub.mjs "$STUB_PORT" > /tmp/uin6b-stub.log 2>&1 &
STUB_PID=$!
for i in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$STUB_PORT/last-prompt" >/dev/null 2>&1 && break; sleep 0.3; done

echo "== 启动服务 =="
DEV_LOG=/tmp/uin6b-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1
done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-uin6b' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
[ -n "$ADMIN" ] && [ "$ADMIN" != null ] || { echo "管理员登录失败"; exit 1; }
# 配上 AI 替身，界面上那一步才跑得到
curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/PARSING" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' \
  -d "{\"baseUrl\":\"http://127.0.0.1:$STUB_PORT/v1\",\"apiKey\":\"stub\",\"model\":\"stub-model\"}"

echo "== 浏览器检查 =="
UI_BASE="http://127.0.0.1:$PORT" UI_USER=admin UI_PASS=adminpass123 UI_DOCX="$DOCX" \
  node test/ui-n6b-import.mjs
RC=$?

# 界面跑完之后回库里核一遍：界面说"入库了"不等于真入库了。
echo "== 回库核对（界面说的和库里的要对得上） =="
one() { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null \
  | jq -r '.[0].results[0] // {} | to_entries[0].value // empty'; }
N=$(one "SELECT COUNT(*) FROM exams WHERE origin='UPLOAD';")
Q=$(one "SELECT COUNT(*) FROM questions q JOIN exams e ON e.exam_id=q.exam_id WHERE e.origin='UPLOAD';")
BAD=$(one "SELECT COUNT(*) FROM questions q JOIN exams e ON e.exam_id=q.exam_id
             WHERE e.origin='UPLOAD' AND (q.answer_state<>'待核' OR q.status='已发布');")
echo "  三种宽度各传一章：内容组 $N 个，题 $Q 道，状态不对的 $BAD 道"
[ "$N" = "3" ] && [ "$Q" = "102" ] && [ "$BAD" = "0" ] || {
  echo "  FAIL 库里的结果与界面说的对不上"; RC=1; }

# 中文文件名要一路原样存下来：浏览器 File.name → 查询串（百分号编码）→ 服务端
# 解码 → content_group_sources.filename。这条链上任何一段编码错了，
# 留下来的都是一串乱码或者空——而上传本身照样成功，界面上看不出来。
FNAME=$(basename "$DOCX")
FN=$(one "SELECT COUNT(*) FROM content_group_sources WHERE filename = '$FNAME';")
echo "  留存里文件名对得上的：$FN 条（应为 3，文件名 $FNAME）"
[ "$FN" = "3" ] || { echo "  FAIL 中文文件名没原样存下来"; RC=1; }

exit $RC
