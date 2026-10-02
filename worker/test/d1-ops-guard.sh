#!/usr/bin/env bash
# 恢复与部署那几个脚本的守卫（CR-M6、M15），不起服务。
#
# 这些脚本调的是线上接口（Cloudflare D1、时间旅行、GitHub 附件），本地连不上，真接口的行为只有
# d1-drill 在线上演练时才看得到。这里测的是**我们自己的分支**：该停的地方停没停、停之前有没有
# 已经发出建库删库请求、有没有已经调 wrangler。办法是两个替身：
#   假 Cloudflare 接口（cf-api-stub.mjs，记下每个请求）；
#   假 npx（排在 PATH 最前面，记下每次调用；需要时按参数回时间旅行的 JSON）。
#
#   find-or-create-d1.sh   找到 / 找不到不许建 / 找不到允许建 / 列表读不了（M15）
#   d1-delete-db.sh        自动化唯一的删库出口：只删 xlearn-drill-* 且 id 对得上
#   d1-create-db.sh        同名就拒绝
#   d1-restore.sh          时间点怎么理解；确认栏不对不动手；整条流程按什么参数调 wrangler
#   d1-restore-check-inputs.sh、d1-backup.sh、d1-import-backup.sh、d1-name.sh、d1-drill.sh 的入口守卫
set -uo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ROOT_DIR/.." && pwd)"
CI="$REPO_DIR/scripts/ci"
STUB_PORT=8890     # 端口表见 CLAUDE.md
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
T=$(mktemp -d)
cleanup() {
  if [ -n "${STUB_PGID:-}" ]; then kill -9 -- "-$STUB_PGID" 2>/dev/null || true; wait "$STUB_PGID" 2>/dev/null; fi
  rm -rf "$T"
}
trap cleanup EXIT

# ---- 假 Cloudflare 接口
STATE="$T/state.json"; REQ="$T/requests.log"; : > "$REQ"
set_state() { printf '%s' "$1" > "$STATE"; : > "$REQ"; }
set_state '{"databases":[],"failList":false}'
setsid node "$ROOT_DIR/test/cf-api-stub.mjs" "$STUB_PORT" "$STATE" "$REQ" > "$T/stub.log" 2>&1 < /dev/null &
STUB_PGID=$!
for i in $(seq 1 50); do curl -s -m 1 "http://127.0.0.1:$STUB_PORT/" >/dev/null 2>&1 && break; sleep 0.2; done
: > "$REQ"
export CF_API_BASE="http://127.0.0.1:$STUB_PORT/client/v4" CLOUDFLARE_ACCOUNT_ID=acc CLOUDFLARE_API_TOKEN=stub-token
n_req() { grep -c "^$1 " "$REQ" || true; }

# ---- 假 npx：记下每次调用；FAKE_NPX_MODE=tt 时按参数回时间旅行的 JSON，否则一律失败
mkdir -p "$T/bin"
cat > "$T/bin/npx" <<'NPX'
#!/usr/bin/env bash
echo "$*" >> "$FAKE_NPX_LOG"
if [ "${FAKE_NPX_MODE:-}" = tt ]; then
  case "$*" in
    *"time-travel info"*"--timestamp"*) echo '{"bookmark":"00000002-00000000-00000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}' ;;
    *"time-travel info"*)               echo '{"bookmark":"00000009-00000000-00000000-cccccccccccccccccccccccccccccccc"}' ;;
    *"time-travel restore"*)            echo '{"bookmark":"00000002-00000000-00000000-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","previous_bookmark":"00000009-00000000-00000000-cccccccccccccccccccccccccccccccc"}' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
case "${FAKE_NPX_MODE:-}" in
  chunks|chunks-short|chunks-fail)
    # 像线上那样整条收下 --command（不拆句），每句回一个结果、结果里带上那句原文好核对顺序；
    # 每次的字节数记进 $FAKE_NPX_LOG.len。chunks-short 每次少回一个；chunks-fail 第 2 次像 D1 那样
    # 把错误写在 stdout、退出码 1
    prev=""; cmd=""
    for a in "$@"; do [ "$prev" = "--command" ] && cmd="$a"; prev="$a"; done
    printf '%s\n' "$(printf '%s' "$cmd" | wc -c)" >> "$FAKE_NPX_LOG.len"
    if [ "$FAKE_NPX_MODE" = chunks-fail ] && [ "$(grep -c '^wrangler d1 execute' "$FAKE_NPX_LOG")" = 2 ]; then
      echo '{"error":{"text":"D1_ERROR: statement too long: SQLITE_TOOBIG"}}'; exit 1
    fi
    printf '%s\n' "$cmd" | jq -R -s -c --arg m "$FAKE_NPX_MODE" '
      split("\n") | map(select(length > 0)) | map({results: [{q: .}], success: true})
      | if $m == "chunks-short" then .[1:] else . end'
    exit 0 ;;
esac
echo "假 npx：不该调到 wrangler" >&2
exit 1
NPX
chmod +x "$T/bin/npx"
export FAKE_NPX_LOG="$T/npx.log"; : > "$FAKE_NPX_LOG"
FAKE_PATH="$T/bin:$PATH"
n_npx() { grep -c . "$FAKE_NPX_LOG" || true; }

echo "== find-or-create-d1.sh（M15：找不到库只在明说允许时才建） =="
fc() { : > "$T/genv"; ALLOW_CREATE_DB="${1:-}" D1_NAME=xlearn GITHUB_ENV="$T/genv" \
       bash "$CI/find-or-create-d1.sh" > "$T/fc.log" 2>&1; echo $?; }
set_state '{"databases":[{"name":"xlearn-old","uuid":"u-old"},{"name":"xlearn","uuid":"u-prod"}],"failList":false}'
check "库在：退出码 0、取的是同名那个、不建库" "$(fc)/$(grep '^D1_DATABASE_ID=' "$T/genv")/$(n_req POST)" "0/D1_DATABASE_ID=u-prod/0"
check "  记下不是新建的" "$(grep '^D1_JUST_CREATED=' "$T/genv")" "D1_JUST_CREATED=false"
set_state '{"databases":[{"name":"xlearn-old","uuid":"u-old"}],"failList":false}'
check "库不在、没说允许：退出码 1、一个建库请求都没发" "$(fc)/$(n_req POST)" "1/0"
check "  报错说没新建、指向恢复手册" "$(grep -c '没有新建' "$T/fc.log")/$(grep -c '数据恢复手册' "$T/fc.log")" "1/1"
check "库不在、ALLOW_CREATE_DB=false：同样不建" "$(fc false)/$(n_req POST)" "1/0"
check "库不在、ALLOW_CREATE_DB=yes（不是 true）：不建" "$(fc yes)/$(n_req POST)" "1/0"
check "库不在、ALLOW_CREATE_DB=true：建一个、记下是新建的" \
  "$(fc true)/$(n_req POST)/$(grep '^D1_JUST_CREATED=' "$T/genv")" "0/1/D1_JUST_CREATED=true"
set_state '{"databases":[],"failList":true}'
check "库列表读不了：退出码 1、不建库" "$(fc true)/$(n_req POST)" "1/0"

echo
echo "== d1-delete-db.sh（自动化里唯一的删库出口） =="
set_state '{"databases":[{"name":"xlearn","uuid":"u-prod"},{"name":"xlearn-restored-20261001","uuid":"u-r"},{"name":"xlearn-drill-123-a","uuid":"u-d"}],"failList":false}'
del() { bash "$CI/d1-delete-db.sh" "$1" "$2" > "$T/del.log" 2>&1; echo $?; }
check "删线上库 xlearn：拒绝、没发删除请求" "$(del xlearn u-prod)/$(n_req DELETE)" "1/0"
check "删恢复出来的新库：拒绝" "$(del xlearn-restored-20261001 u-r)/$(n_req DELETE)" "1/0"
check "名字像演练库但多了一截：拒绝" "$(del xlearn-drill-123-a-x u-d)/$(n_req DELETE)" "1/0"
check "演练库名配上线上库的 id：拒绝" "$(del xlearn-drill-123-a u-prod)/$(n_req DELETE)" "1/0"
check "演练库、id 对得上：删" "$(del xlearn-drill-123-a u-d)/$(n_req DELETE)" "0/1"
check "  删的是那一个，线上库还在" "$(jq -r '[.databases[].name] | join(",")' "$STATE")" "xlearn,xlearn-restored-20261001"

echo
echo "== d1-create-db.sh =="
set_state '{"databases":[{"name":"xlearn","uuid":"u-prod"}],"failList":false}'
ID=$(bash "$CI/d1-create-db.sh" xlearn-restored-20261001 2> "$T/cr.log"); RC=$?
check "新名字：建了、打印 id" "$RC/$(n_req POST)/$ID" "0/1/stub-2-xlearn-restored-20261001"
bash "$CI/d1-create-db.sh" xlearn > /dev/null 2> "$T/cr.log"; RC=$?
check "同名的库已经存在（线上库）：拒绝、没发建库请求" "$RC/$(n_req POST)/$(grep -c '已经有一个叫' "$T/cr.log")" "1/1/1"
bash "$CI/d1-create-db.sh" 'Bad_Name' > /dev/null 2>&1; check "库名不合法：拒绝" "$?" "1"

echo
echo "== d1-restore.sh：时间点怎么理解 =="
pp() { bash "$CI/d1-restore.sh" --parse-only "$1" 2>&1; }
BJ=$(TZ=Asia/Shanghai date -d '-2 hours' '+%F %H:%M')
check "北京时间（不带时区）按北京时间理解，换成世界时" \
  "$(pp "$BJ" | grep -c "即世界时 $(date -u -d "$BJ +08:00" +%FT%H:%M:00Z)")" "1"
check "带 Z 的 RFC3339 原样理解" "$(pp "$(date -u -d '-1 day' +%FT%H:%M:%SZ)" | grep -c "即世界时 $(date -u -d '-1 day' +%FT%H:%M:%SZ)")" "1"
check "书签按书签" "$(pp 00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683 | grep -c '按书签恢复')" "1"
pp "$(TZ=Asia/Shanghai date -d '+1 day' '+%F %H:%M')" > /dev/null; check "将来的时间：拒绝" "$?" "1"
pp "$(date -u -d '-40 days' +%FT%TZ)" > /dev/null; check "40 天前：拒绝（时间旅行回不去）" "$?" "1"
check "10 天前：放行但警告免费版回不去" "$(pp "$(date -u -d '-10 days' +%FT%TZ)" | grep -c '超过 7 天')" "1"
pp "2026-02-30 10:00" > /dev/null; check "不存在的日期：拒绝" "$?" "1"
pp "昨天下午" > /dev/null; check "看不懂的写法：拒绝" "$?" "1"

echo
echo "== d1-restore.sh：确认栏不对不动手；整条流程按什么参数调 wrangler =="
: > "$FAKE_NPX_LOG"
PATH="$FAKE_PATH" D1_NAME=xlearn CONFIRM_NAME=xlean bash "$CI/d1-restore.sh" "$BJ" > "$T/r.log" 2>&1; RC=$?
check "确认栏填错（xlean）：退出码 1、一次 wrangler 都没调" "$RC/$(n_npx)" "1/0"
PATH="$FAKE_PATH" D1_NAME=xlearn bash "$CI/d1-restore.sh" "$BJ" > "$T/r.log" 2>&1; RC=$?
check "确认栏空着：同样不动手" "$RC/$(n_npx)" "1/0"
: > "$FAKE_NPX_LOG"
PATH="$FAKE_PATH" FAKE_NPX_MODE=tt D1_NAME=xlearn CONFIRM_NAME=xlearn bash "$CI/d1-restore.sh" "$BJ" > "$T/r.log" 2>&1; RC=$?
check "确认对了：恢复走完" "$RC" "0"
check "  先取现在的书签（撤销的退路），再换时间点，最后恢复" \
  "$(sed -E 's/^wrangler d1 time-travel ([a-z]+) xlearn.*--timestamp.*/\1+时间点/; s/^wrangler d1 time-travel ([a-z]+) xlearn.*/\1/' "$FAKE_NPX_LOG" | paste -sd, -)" "info,info+时间点,restore"
check "  时间点按北京时间换成世界时交给 wrangler" \
  "$(grep -c -- "--timestamp $(date -u -d "$BJ +08:00" +%FT%H:%M:00Z)" "$FAKE_NPX_LOG")" "1"
check "  恢复用的是时间点换出来的书签" "$(grep -c -- 'restore xlearn --bookmark 00000002-' "$FAKE_NPX_LOG")" "1"
check "  打出了撤销书签" "$(grep -c '时间点填 00000009-' "$T/r.log")" "1"
: > "$FAKE_NPX_LOG"
PATH="$FAKE_PATH" FAKE_NPX_MODE=tt D1_NAME=xlearn CONFIRM_NAME=xlearn \
  bash "$CI/d1-restore.sh" 00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683 > "$T/r.log" 2>&1; RC=$?
check "按书签：不换时间点，直接用这个书签恢复" \
  "$RC/$(grep -c -- '--timestamp' "$FAKE_NPX_LOG")/$(grep -c -- 'restore xlearn --bookmark 00000085-' "$FAKE_NPX_LOG")" "0/0/1"

echo
echo "== d1-restore-check-inputs.sh =="
ci() { env -i PATH="$PATH" D1_NAME=xlearn "$@" bash "$CI/d1-restore-check-inputs.sh" > "$T/ci.log" 2>&1; echo $?; }
check "time-travel、确认填线上库名：通过" "$(ci MODE=time-travel POINT="$BJ" CONFIRM_NAME=xlearn)" "0"
check "time-travel、确认填错：停" "$(ci MODE=time-travel POINT="$BJ" CONFIRM_NAME=xlearn-x)" "1"
check "time-travel、时间点看不懂：停" "$(ci MODE=time-travel POINT=yesterday CONFIRM_NAME=xlearn)" "1"
check "backup、齐全：通过" "$(ci MODE=backup BACKUP_RUN_ID=123 NEW_DB_NAME=xlearn-restored-1 CONFIRM_NAME=xlearn-restored-1)" "0"
check "backup、新库名写成线上库名：停" "$(ci MODE=backup BACKUP_RUN_ID=123 NEW_DB_NAME=xlearn CONFIRM_NAME=xlearn)" "1"
check "backup、运行编号不是数字：停" "$(ci MODE=backup BACKUP_RUN_ID=abc NEW_DB_NAME=xlearn-r CONFIRM_NAME=xlearn-r)" "1"
check "backup、确认没填新库名：停" "$(ci MODE=backup BACKUP_RUN_ID=123 NEW_DB_NAME=xlearn-r CONFIRM_NAME=xlearn)" "1"
check "方式填错：停" "$(ci MODE=rollback CONFIRM_NAME=xlearn)" "1"

echo
echo "== d1-backup.sh / d1-import-backup.sh 的入口守卫（停之前一次 wrangler 都没调） =="
: > "$FAKE_NPX_LOG"
PATH="$FAKE_PATH" D1_NAME=xlearn bash "$CI/d1-backup.sh" --remote "$T/bk1" > "$T/b.log" 2>&1; RC=$?
check "没有口令：停，并说明怎么建 Secret" "$RC/$(grep -c 'BACKUP_PASSPHRASE' "$T/b.log")/$(n_npx)" "1/1/0"
PATH="$FAKE_PATH" D1_NAME=xlearn BACKUP_PASSPHRASE=short bash "$CI/d1-backup.sh" --remote "$T/bk2" > "$T/b.log" 2>&1; RC=$?
check "口令太短：停" "$RC/$(n_npx)" "1/0"
mkdir -p "$T/bk3"; touch "$T/bk3/old"
PATH="$FAKE_PATH" D1_NAME=xlearn BACKUP_PASSPHRASE=0123456789abcdefXYZ bash "$CI/d1-backup.sh" --remote "$T/bk3" > "$T/b.log" 2>&1; RC=$?
check "输出目录不是空的：停" "$RC/$(n_npx)" "1/0"
mkdir -p "$T/fakebk"; echo '{"file":"x.sql.gpg","cipherSha256":"0"}' > "$T/fakebk/manifest.json"; echo x > "$T/fakebk/x.sql.gpg"
PATH="$FAKE_PATH" BACKUP_PASSPHRASE=0123456789abcdefXYZ bash "$CI/d1-import-backup.sh" --remote "$T/fakebk" xlearn > "$T/i.log" 2>&1; RC=$?
check "目标写成线上库（从 wrangler.toml 读到的 xlearn）：停" "$RC/$(grep -c '目标是线上库' "$T/i.log")/$(n_npx)" "1/1/0"
PATH="$FAKE_PATH" BACKUP_PASSPHRASE=0123456789abcdefXYZ bash "$CI/d1-import-backup.sh" --remote "$T/fakebk" xlearn-restored-1 > "$T/i.log" 2>&1; RC=$?
check "密文和 manifest 的校验和对不上：停" "$RC/$(grep -c '校验和' "$T/i.log")/$(n_npx)" "1/1/0"
PATH="$FAKE_PATH" BACKUP_PASSPHRASE=0123456789abcdefXYZ bash "$CI/d1-import-backup.sh" --remote "$T/nope" xlearn-restored-1 > "$T/i.log" 2>&1; RC=$?
check "备份目录不存在：停" "$RC/$(n_npx)" "1/0"

echo
echo "== d1-query-chunks.sh：分批发、按原顺序合并、对不上就停（假 npx 像线上那样整条收下命令） =="
qc() {  # qc <语句文件> → stdout 进 $T/qc.json、stderr 进 $T/qc.err，打印退出码
  : > "$FAKE_NPX_LOG"; : > "$FAKE_NPX_LOG.len"
  PATH="$FAKE_PATH" bash "$CI/d1-query-chunks.sh" --remote xlearn-x "$1" > "$T/qc.json" 2> "$T/qc.err"; echo $?
}
n_exec() { grep -c '^wrangler d1 execute' "$FAKE_NPX_LOG" || true; }
order() { jq -c '[.[].results[0].q | capture("SELECT (?<n>[0-9]+)").n | tonumber]' "$T/qc.json" 2>/dev/null; }
printf 'SELECT %d AS n, '"'"'abcdefghijklmnop'"'"' AS pad;\n' 1 2 3 4 5 > "$T/five.sql"   # 每句 41 字节，连换行 42
RC=$(FAKE_NPX_MODE=chunks qc "$T/five.sql")
check "不设上限（默认 40000）：5 句一批发完" "$RC/$(n_exec)" "0/1"
RC=$(FAKE_NPX_MODE=chunks D1_SQL_BUDGET=100 qc "$T/five.sql")
check "上限 100 字节：分 3 批发（2 + 2 + 1 句）" "$RC/$(n_exec)" "0/3"
check "  每批都不超过 100 字节（最长 $(sort -n "$FAKE_NPX_LOG.len" | tail -1)）" "$(( $(sort -n "$FAKE_NPX_LOG.len" | tail -1) <= 100 ))" "1"
check "  结果按原顺序合成一个数组，每句一项" "$(order)" "[1,2,3,4,5]"
check "  stderr 最后一行报分批情况" "$(tail -1 "$T/qc.err")" "分批：分 3 批（最长 83 字节）"
{ echo "SELECT 1 AS n;"; printf 'SELECT 2 AS n, '"'"'%0150d'"'"' AS pad;\n' 0; echo "SELECT 3 AS n;"; } > "$T/long.sql"
RC=$(FAKE_NPX_MODE=chunks D1_SQL_BUDGET=100 qc "$T/long.sql")
check "单独一句就超过上限：自成一批，一句都没丢、顺序不变" "$RC/$(n_exec)/$(order)" "0/3/[1,2,3]"
printf '\n\n' > "$T/blank.sql"
RC=$(FAKE_NPX_MODE=chunks qc "$T/blank.sql")
check "没有语句：输出空数组，一次 wrangler 都没调" "$RC/$(cat "$T/qc.json")/$(n_exec)" "0/[]/0"
RC=$(FAKE_NPX_MODE=chunks-short D1_SQL_BUDGET=100 qc "$T/five.sql")
check "D1 回的结果比发的句子少：停、说清发了几句回了几个、不输出半截结果" \
  "$RC/$(grep -c '发了 5 句，D1 回了 2 个结果' "$T/qc.err")/$(grep -c . "$T/qc.json")" "1/1/0"
RC=$(FAKE_NPX_MODE=chunks-fail D1_SQL_BUDGET=100 qc "$T/five.sql")
check "第 2 批 D1 报错：停在第 2 批、带出 D1 写在 stdout 的报错、不输出半截结果" \
  "$RC/$(n_exec)/$(grep -c '第 2/3 批.*statement too long' "$T/qc.err")/$(grep -c . "$T/qc.json")" "1/2/1/0"
RC=$(FAKE_NPX_MODE=chunks D1_SQL_BUDGET=4万 qc "$T/five.sql")
check "上限不是正整数：停，一次 wrangler 都没调" "$RC/$(n_exec)" "1/0"
RC=$(FAKE_NPX_MODE=chunks qc "$T/nope.sql")
check "语句文件不存在：停" "$RC/$(n_exec)" "1/0"

echo
echo "== d1-name.sh：库名只有一个出处 =="
check "读到 wrangler.toml 里的库名" "$(bash "$CI/d1-name.sh")" \
  "$(grep -E '^database_name' "$ROOT_DIR/wrangler.toml" | head -1 | sed -E 's/.*"([^"]*)".*/\1/')"
printf 'name = "x"\n' > "$T/bad.toml"
WRANGLER_TOML="$T/bad.toml" bash "$CI/d1-name.sh" > /dev/null 2>&1; check "没有 database_name：失败，不给默认值" "$?" "1"

echo
echo "== d1-drill.sh：运行编号不对就不开始（一个接口请求都没发） =="
set_state '{"databases":[{"name":"xlearn","uuid":"u-prod"}],"failList":false}'
DRILL_ID="12a" bash "$CI/d1-drill.sh" > "$T/d.log" 2>&1; RC=$?
check "运行编号不是数字：退出码 1" "$RC/$(grep -c . "$REQ")" "1/0"

echo
echo "== d1-fetch-backup.sh：运行编号不对就不去取 =="
cat > "$T/bin/gh" <<'GH'
#!/usr/bin/env bash
echo "gh $*" >> "$FAKE_NPX_LOG"; exit 1
GH
chmod +x "$T/bin/gh"; : > "$FAKE_NPX_LOG"
PATH="$FAKE_PATH" GITHUB_REPOSITORY=o/r bash "$CI/d1-fetch-backup.sh" "$T/fb" "12a" > "$T/f.log" 2>&1; RC=$?
check "运行编号不是数字：停、没调 gh" "$RC/$(n_npx)" "1/0"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
