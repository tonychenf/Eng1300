#!/usr/bin/env bash
# 富媒体题干的浏览器检查：备库 → 拷资源 → 起服务 → 开一份卷 →
# 给第一题挂上图和公式 → 跑用例（验收 G1、G4）。
set -uo pipefail
cd "$(dirname "$0")/.."

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8784          # 端口表见 CLAUDE.md
BASE="http://127.0.0.1:$PORT/api"
ROOT_DIR="$(pwd)"
TMP_ASSET_DIR="$ROOT_DIR/../data/subjects/english/assets/ui-rich"

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -- -"$SERVER_PGID" 2>/dev/null
  rm -f .dev.vars
  rm -rf "$TMP_ASSET_DIR" "$ROOT_DIR/public/bank/english/ui-rich"
}
trap cleanup EXIT

if [ ! -d public ]; then
  echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1
fi

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-uirich
SETUP_TOKEN=test-setup-uirich
ENCRYPTION_KEY=test-encryption-key-uirich
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=seed/english-000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2015-04 00015-2016-04 00015-2019-10 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

echo "== 拷题库资源 =="
mkdir -p "$TMP_ASSET_DIR"
cp test/fixtures/n5b-good/assets/ch01/fig1.png "$TMP_ASSET_DIR/fig.png"
node ../scripts/build-bank-assets.mjs >/dev/null || { echo "拷资源失败"; exit 1; }
[ -f public/bank/english/ui-rich/fig.png ] || { echo "资源没拷进 public/bank"; exit 1; }

echo "== 启动服务 =="
DEV_LOG=/tmp/ui-rich-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1
done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

echo "== 账号与卷子 =="
curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-uirich' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
UI_PASS=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"UI601","subjects":["english"]}' | jq -r '.initialPassword')
[ -n "$UI_PASS" ] && [ "$UI_PASS" != null ] || { echo "建学员账号失败"; exit 1; }
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$UI_PASS" '{username:"UI601",password:$p}')" | jq -r '.token')
ATTEMPT=$(curl -s -X POST "$BASE/exams/generate" -H "Authorization: Bearer $STU" \
  -H 'Content-Type: application/json' -d '{"courseCode":"13000"}' | jq -r '.attemptId')
[ -n "$ATTEMPT" ] && [ "$ATTEMPT" != null ] || { echo "组卷失败"; exit 1; }

sql() { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one() { sql "$1" | jq -r '.[0].results[0] // {} | to_entries[0].value // empty'; }
QID=$(one "SELECT question_id FROM attempt_questions WHERE attempt_id='$ATTEMPT' AND ord=1;")
ENG=$(one "SELECT subject_id FROM subjects WHERE code='english';")
ALT='腺嘌呤与胸腺嘧啶之间形成两个氢键'
# 给第一题换上带图带公式的题干。挑第一题是因为它在页面最上面，
# 三种宽度下都不用翻部分就能看到；这里不依赖它原本是什么题型——
# 题干渲染由标记决定，与题型无关。
npx wrangler d1 execute "$D1_NAME" --local --command \
  "UPDATE questions SET stem = '下图 ![fig1] 中，氢键数目满足 \$\\frac{a}{b}\$ 吗？' WHERE question_id='$QID';" >/dev/null 2>&1
npx wrangler d1 execute "$D1_NAME" --local --command \
  "INSERT OR REPLACE INTO question_assets (question_id, asset_key, subject_id, kind, path, alt, caption)
   VALUES ('$QID', 'fig1', $ENG, 'IMAGE', 'english/ui-rich/fig.png', '$ALT', '图 1 构造图');" >/dev/null 2>&1
N=$(one "SELECT COUNT(*) FROM question_assets WHERE question_id='$QID';")
[ "$N" = "1" ] || { echo "挂图失败"; exit 1; }
echo "  第 1 题（$QID）已挂上图与公式"

echo "== 浏览器检查 =="
UI_BASE="http://127.0.0.1:$PORT" UI_USER=UI601 UI_PASS="$UI_PASS" \
  UI_ATTEMPT="$ATTEMPT" UI_ORD=1 UI_ALT="$ALT" UI_IMG_PATH='english/ui-rich/fig.png' \
  node test/ui-rich-stem.mjs
