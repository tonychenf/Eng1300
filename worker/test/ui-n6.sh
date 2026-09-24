#!/usr/bin/env bash
# N6 后台界面的浏览器实测（三种宽度）。
# 要两个学科的内容组同时在库里：只有英语的话"内容组显示 label 而不是年月"
# 这条永远成立（英语的 label 里本来就写着年月），测不出东西。
set -uo pipefail
cd "$(dirname "$0")/.."

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8782          # 端口表见 CLAUDE.md
BASE="http://127.0.0.1:$PORT/api"
ROOT_DIR="$(pwd)"
BIO_SEED=/tmp/ui-n6-seed-bio

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -- -"$SERVER_PGID" 2>/dev/null
  rm -f .dev.vars; rm -rf "$BIO_SEED"
}
trap cleanup EXIT

if [ ! -d public ]; then
  echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1
fi

echo "== 准备本地数据库（英语 + 生化） =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-uin6
SETUP_TOKEN=test-setup-uin6
ENCRYPTION_KEY=test-encryption-key-uin6
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=seed/000-knowledge-points.sql >/dev/null 2>&1
for EXAM in 00015-2015-04 13000-2026-04; do
  F=$(ls seed/*"$EXAM".sql 2>/dev/null | head -1)
  [ -n "$F" ] || { echo "找不到 $EXAM 的种子"; exit 1; }
  npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
done
rm -rf "$BIO_SEED"
SEED_SUBJECT_DIR="$ROOT_DIR/../data/subjects/biochem" \
  node ../scripts/build-seed-sql.mjs "$BIO_SEED" >/tmp/ui-n6-seed.log 2>&1 \
  || { echo "生化种子生成失败："; cat /tmp/ui-n6-seed.log; exit 1; }
for f in "$BIO_SEED"/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$f" >/dev/null 2>&1 || { echo "导入 $f 失败"; exit 1; }
done
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1

sql() { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one() { sql "$1" | jq -r '.[0].results[0] // {} | to_entries[0].value // empty'; }
BIO_LABEL=$(one "SELECT label FROM exams WHERE exam_id='biochem-ch01';")
UNREVIEWED=$(one "SELECT COUNT(*) FROM questions WHERE answer_state='待核';")
[ -n "$BIO_LABEL" ] || { echo "生化内容组没进库"; exit 1; }
[ "${UNREVIEWED:-0}" -gt 0 ] || { echo "一道待核的题都没有，这套测不出东西"; exit 1; }
echo "  生化内容组：$BIO_LABEL，待核 $UNREVIEWED 题"

echo "== 启动服务 =="
DEV_LOG=/tmp/ui-n6-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1
done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-uin6' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'

echo "== 浏览器检查 =="
UI_BASE="http://127.0.0.1:$PORT" UI_USER=admin UI_PASS=adminpass123 \
  UI_BIO_GROUP=biochem-ch01 UI_BIO_LABEL="$BIO_LABEL" UI_UNREVIEWED="$UNREVIEWED" \
  node test/ui-n6-admin.mjs
