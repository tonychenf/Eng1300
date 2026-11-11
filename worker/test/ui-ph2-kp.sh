#!/usr/bin/env bash
# 改进阶段 2 第三期 F·考点整理的浏览器检查，三种宽度各走一遍（公共英语的考点，每种宽度动不同的几个）：
# 学科管理 →「考点整理」→ 列表 → 改名（重名报错、改成功）→ 调上级 → 合并到另一个（题数转过去、这一行没了）。
set -uo pipefail
cd "$(dirname "$0")/.."

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8762          # 端口表见 CLAUDE.md
BASE="http://127.0.0.1:$PORT/api"
WORK=$(mktemp -d)

cleanup() {
  [ -n "${SERVER_PGID:-}" ] && kill -- -"$SERVER_PGID" 2>/dev/null
  rm -f .dev.vars
  rm -rf "$WORK"
}
trap cleanup EXIT

[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }

echo "== 准备本地数据库：迁移 + 公共英语（参照它开新课） =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-uiph2kp
SETUP_TOKEN=test-setup-uiph2kp
ENCRYPTION_KEY=test-encryption-key-uiph2kp
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

echo "== 启动服务 =="
DEV_LOG=/tmp/ui-ph2-kp-dev.log
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1; done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-uiph2kp' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
SID=$(one "SELECT subject_id FROM subjects WHERE code = 'pubeng';")
echo "== 浏览器检查 =="
UI_BASE="http://127.0.0.1:$PORT" UI_SID="$SID" UI_KP_FILE="$(pwd)/../data/subjects/pubeng/knowledge-points.json" node test/ui-ph2-kp.mjs
