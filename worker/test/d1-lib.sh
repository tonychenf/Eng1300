#!/usr/bin/env bash
# 读库助手 test/lib/d1.sh 的两条路逐条比对（CR-M12）。
#
# 助手在服务起来之后走 dev 服务的本地接口，之前（和单独在真实目录里跑时）走 wrangler d1 execute。
# 二十来套测试的断言都建在它的输出上，两条路的输出只要有一处形状不一样（列顺序、NULL、数字、
# 中文、多行、没有行、报错），那些断言就会在一条路上对、另一条路上错，而且哪条路被用到取决于
# 调用发生在服务起来之前还是之后——这种错很难查。所以同一批查询两条路各走一遍，逐条比。
#
# 期望值不从被测的助手里来：比对的两边是两份独立实现（接口 + 形状转换 vs wrangler 自己的输出），
# 具体值的断言用的是 SQL 里写死的字面量。
#
# 另外钉住三条行为：连不上才退回命令；超时和回的东西看不懂都算失败、不退回；
# D1_TRACE 如实记下每次走的是哪条路。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8776          # 端口表见 CLAUDE.md
HANG_PORT=8892     # 只接连接、永远不回的假服务（测超时不退回）
JUNK_PORT=8891     # 回 404 纯文本的假服务（测看不懂不退回）
DEV_LOG=/tmp/d1lib-dev.log
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

# 自带一份沙箱：本地接口要一个非空的 database_id，而真实目录里它必须留空（CLAUDE.md 四之二）。
# 在 run-all.sh 里跑时外面已经是沙箱了，但单独跑这一套也得测得到接口那条路。
BOX=$(mktemp -d)
cleanup() {
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  if [ -n "${FAKE_PIDS:-}" ]; then kill $FAKE_PIDS 2>/dev/null || true; fi
  rm -rf "$BOX"
}
trap cleanup EXIT
mkdir -p "$BOX/worker/test"
cp -a src migrations wrangler.toml package.json public "$BOX/worker/" || { echo "建沙箱失败"; exit 1; }
cp -a test/lib "$BOX/worker/test/"
ln -s "$ROOT_DIR/node_modules" "$BOX/worker/node_modules"
FAKE=00000000-0000-4000-8000-00000000d11b
sed -i "s/^database_id = .*/database_id = \"$FAKE\"/" "$BOX/worker/wrangler.toml"
cd "$BOX/worker"
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-d1lib
SETUP_TOKEN=test-setup-d1lib
ENCRYPTION_KEY=test-encryption-key-d1lib
VARS
export WRANGLER_SEND_METRICS=false CLOUDFLARE_CF_FETCH_ENABLED=false
export D1_TRACE="$BOX/trace"; : > "$D1_TRACE"
source test/lib/d1.sh
last_via() { tail -1 "$D1_TRACE" | cut -f1; }
n_via() { grep -c "^$1" "$D1_TRACE" || true; }

echo "== 准备：一张专用的表（不用整套迁移，这里测的是助手，不是业务表） =="
check "（前提）助手读到的是沙箱里的假 id" "$_D1_ID" "$FAKE"
PORT= exec_sql "CREATE TABLE d1lib (id INTEGER PRIMARY KEY, name TEXT, score REAL, note TEXT);
  INSERT INTO d1lib VALUES (1, '甲', 90.5, NULL), (2, 'b''s', 60, 'x'), (3, '丙', 0, '');" \
  || { echo "建表失败"; exit 1; }

echo "== 启动服务 =="
for i in $(seq 1 20); do
  grep -qx "$(printf '%04X' $PORT)" <(awk 'NR>1 && $4 == "0A" {split($2,a,":"); print a[2]}' /proc/net/tcp 2>/dev/null) || break
  sleep 1
done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 -o /dev/null "http://127.0.0.1:$PORT/cdn-cgi/local/explorer/api/d1/database" && { ready=1; break; }
  sleep 1
done
[ "$ready" = 1 ] || { echo "服务在 150 秒内没有就绪。dev 日志尾部："; tail -20 "$DEV_LOG"; exit 1; }

echo "== 服务起来之后走接口；PORT 置空时走命令 =="
: > "$D1_TRACE"
one "SELECT COUNT(*) FROM d1lib" >/dev/null
check "服务在的时候走本地接口" "$(last_via)" "http"
PORT= one "SELECT COUNT(*) FROM d1lib" >/dev/null
check "PORT 置空时走命令" "$(last_via)" "cli"

# 同一条 SQL 两条路各走一遍，只比 results（meta 两边本来就不一样，调用方也不用）。
# 接口那边的结果留在 $SAME 里给后面断具体值——不能写成 V=$(same …)：那样 check 在子 shell 里，
# 计数丢了，OK/FAIL 那行也被吞进变量。
same() {
  local c
  SAME=$(sql "$1" | jq -c '[.[] | .results]'); c=$(PORT= sql "$1" | jq -c '[.[] | .results]')
  check "$2：两条路输出一致" "$SAME" "$c"
}

echo "== 形状 =="
same "SELECT 42 AS i, 1.5 AS f, NULL AS n, 'it''s 中文' AS s, '' AS e" "数字/小数/NULL/引号中文/空串"
check "  值本身对（整数、小数、NULL、引号、空串）" "$SAME" '[[{"i":42,"f":1.5,"n":null,"s":"it'"'"'s 中文","e":""}]]'
same "SELECT 'a
b' AS s" "字符串里带换行"
check "  换行原样保留" "$(echo "$SAME" | jq -r '.[0][0].s')" "$(printf 'a\nb')"
same "SELECT id, name, score, note FROM d1lib ORDER BY id" "多行多列"
check "  三行、列顺序是 id,name,score,note" "$(echo "$SAME" | jq -c '[(.[0] | length), (.[0][0] | keys_unsorted)]')" '[3,["id","name","score","note"]]'
same "SELECT * FROM d1lib WHERE 1 = 0" "没有行"
check "  没有行就是空数组" "$SAME" '[[]]'
same "SELECT 1 AS a, 2 AS a" "同名列"
check "one：两条路一致，且等于表里的行数" "$(one "SELECT COUNT(*) FROM d1lib")/$(PORT= one "SELECT COUNT(*) FROM d1lib")" "3/3"
check "one 没有行时两条路都是空" "[$(one "SELECT id FROM d1lib WHERE id = 99")][$(PORT= one "SELECT id FROM d1lib WHERE id = 99")]" "[][]"

echo "== 报错 =="
: > "$D1_TRACE"
H=$(sql "SELECT * FROM no_such_table" 2>"$BOX/eh"); HRC=$?
C=$(PORT= sql "SELECT * FROM no_such_table" 2>"$BOX/ec"); CRC=$?
check "SQL 报错两条路退出码都不是 0" "$HRC/$CRC" "1/1"
check "stdout 上都是 {error:{text}}，都说没有这张表" \
  "$(echo "$H" | jq -r '.error.text' | grep -c 'no such table')/$(echo "$C" | jq -r '.error.text' | grep -c 'no such table')" "1/1"
check "stderr 上都打了那行读库失败" "$(grep -c '!! 读库命令失败' "$BOX/eh")/$(grep -c '!! 读库命令失败' "$BOX/ec")" "1/1"
check "接口报错时没有悄悄退回命令再试一遍" "$(n_via http)/$(n_via cli)" "1/1"
check "one 读库失败时退出码不是 0" "$(one "SELECT * FROM no_such_table" 2>/dev/null; echo $?)" "1"

echo "== 写库：多条语句、两边互相看得见 =="
exec_sql "INSERT INTO d1lib VALUES (10, '接口一', 1, NULL); INSERT INTO d1lib VALUES (11, '接口二', 2, NULL);
          UPDATE d1lib SET note = '改过' WHERE id IN (10, 11);"
check "接口一次给三条语句，三条都执行了（从命令那边读）" \
  "$(PORT= one "SELECT COUNT(*) FROM d1lib WHERE id IN (10, 11) AND note = '改过'")" "2"
PORT= exec_sql "INSERT INTO d1lib VALUES (20, '命令写的', 3, NULL);"
check "命令写的，接口那边读得到" "$(one "SELECT name FROM d1lib WHERE id = 20")" "命令写的"

echo "== 服务收了：连不上才退回命令 =="
kill -9 -- "-$SERVER_PGID" 2>/dev/null; wait "$SERVER_PGID" 2>/dev/null; SERVER_PGID=
for i in $(seq 1 20); do curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/" || break; sleep 1; done
: > "$D1_TRACE"
check "服务收了之后照样读得到" "$(one "SELECT COUNT(*) FROM d1lib")" "6"
check "  这次走的是命令" "$(cat "$D1_TRACE" | cut -f1 | tr '\n' ',')" "cli,"

echo "== 超时、看不懂：算失败，不退回 =="
node -e "require('net').createServer((s) => { s.on('error', () => {}); }).listen($HANG_PORT, '127.0.0.1')" &
FAKE_PIDS="$!"
node -e "require('http').createServer((q, r) => { r.writeHead(404, {'Content-Type': 'text/plain'}); r.end('Not Found'); }).listen($JUNK_PORT, '127.0.0.1')" &
FAKE_PIDS="$FAKE_PIDS $!"
for i in $(seq 1 20); do curl -s -m 1 -o /dev/null "http://127.0.0.1:$JUNK_PORT/" && break; sleep 0.5; done
# 挂起的那个：连得上、但一直不回（curl 退出码 28），才算起来了；还没监听时是 7（连不上）
for i in $(seq 1 20); do curl -s -m 1 -o /dev/null "http://127.0.0.1:$HANG_PORT/"; [ $? -eq 28 ] && break; sleep 0.5; done
: > "$D1_TRACE"
OUT=$(PORT=$HANG_PORT D1_HTTP_TIMEOUT=2 one "SELECT COUNT(*) FROM d1lib" 2>"$BOX/et"); RC=$?
check "接口不回话：退出码不是 0" "$RC" "1"
check "  stderr 说的是超时" "$(grep -c '读库命令失败（本地接口，curl 退出码 28' "$BOX/et")" "1"
check "  没有退回命令（退回去就把服务卡死藏起来了）" "$(cut -f1 "$D1_TRACE" | tr '\n' ',')" "http,"
: > "$D1_TRACE"
OUT=$(PORT=$JUNK_PORT one "SELECT COUNT(*) FROM d1lib" 2>"$BOX/ej"); RC=$?
check "接口回的东西看不懂：退出码不是 0" "$RC" "1"
check "  stderr 说看不懂，并带上收到的内容" "$(grep -c '本地接口回的东西看不懂，HTTP 404）.*Not Found' "$BOX/ej")" "1"
check "  没有退回命令" "$(cut -f1 "$D1_TRACE" | tr '\n' ',')" "http,"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
