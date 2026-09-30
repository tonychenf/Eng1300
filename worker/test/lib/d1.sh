# 各套件共用的读库助手（CR-M9、CR-M12）。套件自己先设好 D1_NAME，再 source 这个文件：
#
#   source "$ROOT_DIR/test/lib/d1.sh"
#
# 要指定本地库目录的套件（cr-auth-limits）在 source 之前设 D1_PERSIST。
#
# 为什么要抽出来：以前每套各抄一份
#   sql() { npx wrangler d1 execute ... --command "$1" 2>/dev/null; }
# 命令失败时 stderr 被丢掉，调用方拿到空串或一段报错 JSON，断言照常拿它去比——
# 于是"读库失败"和"库里就是空的"在输出里长得一模一样。n5-items 出过一次读回为空、
# 重跑不复现，事后连是哪条 SQL、报的什么都查不到。
#
# 现在失败时 stdout 照旧（调用方的比较逻辑一点不变），另外往 stderr 打一行
#   !! 读库命令失败（…）：<SQL 开头>｜<报错>
# run-all.sh 会把出现过这一行的套件单独点名，哪怕它的断言碰巧全绿。
# 不重试：重试会把"偶尔读不到"藏起来，而这类问题要先看得见才谈得上修。
#
# ---- 两条路（CR-M12）----
# 1. 本地接口：套件的服务起来之后，走 dev 服务自己的库——
#      POST http://127.0.0.1:$PORT/cdn-cgi/local/explorer/api/d1/database/<database_id>/raw
#    一次十几毫秒；另起一个 wrangler 进程要 2.4 秒，一轮回归几百次，是耗时的大头。
#    也不再有第二个进程和 dev 服务同时开同一个库。
#    接口按 database_id 找库，而真实的 wrangler.toml 里 database_id 必须留空（CLAUDE.md 四之二），
#    路径里拼不出来——所以这条路只在 run-all.sh 的沙箱里通：它把副本里的 database_id 换成了
#    一个假 id。单独在真实目录里跑某一套，一律走第 2 条路，和以前完全一样。
# 2. wrangler d1 execute --local：服务还没起来（迁移、导种子）、已经收了、不起服务的套件、
#    或者上面的条件不满足时。
#
# 接口连不上（curl 退出码 7：服务还没起、已经收了）才退回第 2 条路。接口超时、回的东西看不懂，
# 都算失败、不退回——退回去会把"服务卡死了"藏成"读库照常成功"。
#
# 两条路的输出做成一个形状（wrangler d1 execute --json 那样的 [{results:[{列:值}],success,meta}]），
# 调用方一行不用改。差别只有一处：一次给多条语句时，接口只回最后一条的结果（每条都会执行），
# 命令回每一条的。现有调用里多语句的只有 m4-smoke 两处，输出都丢掉了。test/d1-lib.sh 逐条比对两条路。
#
# 报错在哪：SQL 错（没有这张表、违反约束）时 wrangler 退出码 1，报错是 stdout 上的
# {"error":{"text":…}}，stderr 里只有一句代理提示；wrangler 自己起不来时报错才在 stderr。
# 所以先取 stdout 的 .error.text，取不到再取 stderr 尾部。接口的报错在 .errors[0].message，
# 转成同样的 {"error":{"text":…}} 放到 stdout 上。
#
# D1_TRACE 设成一个文件路径时，每次调用往里追加一行「http|cli<TAB>SQL 开头」，
# 看得见每次到底走了哪条路（run-all.sh 用它汇总；d1-lib.sh 用它断言没有悄悄退回）。

_D1_TOML="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/wrangler.toml"
_D1_ID=$(grep -E '^database_id' "$_D1_TOML" 2>/dev/null | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
D1_HTTP_TIMEOUT=${D1_HTTP_TIMEOUT:-30}

_d1_head() { printf '%s' "$1" | jq -Rrs 'gsub("\\s+"; " ") | .[0:80]'; }
_d1_trace() { [ -n "${D1_TRACE:-}" ] && printf '%s\t%s\n' "$1" "$(_d1_head "$2")" >> "$D1_TRACE"; return 0; }

# 走本地接口。返回 0 成功（stdout 是上面说的形状）；1 失败（已经往 stderr 报过）；2 这条路走不通。
_d1_http() {
  [ -n "${_D1_ID:-}" ] && [ -n "${PORT:-}" ] || return 2
  local resp rc code body why
  resp=$(curl -s -m "$D1_HTTP_TIMEOUT" -w '\n%{http_code}' -X POST \
    "http://127.0.0.1:$PORT/cdn-cgi/local/explorer/api/d1/database/$_D1_ID/raw" \
    -H 'Content-Type: application/json' --data-binary "$(jq -n --arg s "$1" '{sql: $s}')")
  rc=$?
  [ "$rc" -eq 7 ] && return 2
  _d1_trace http "$1"
  if [ "$rc" -ne 0 ]; then
    printf '  !! 读库命令失败（本地接口，curl 退出码 %s，%s 秒没回）：%s\n' "$rc" "$D1_HTTP_TIMEOUT" "$(_d1_head "$1")" >&2
    return 1
  fi
  code=${resp##*$'\n'}; body=${resp%$'\n'*}
  if [ "$(printf '%s' "$body" | jq -r '.success // empty' 2>/dev/null)" = "true" ]; then
    printf '%s' "$body" | jq -c '[.result[] | {
        results: ((.results.columns // []) as $c
                  | [(.results.rows // [])[] | [$c, .] | transpose
                     | map({key: .[0], value: .[1]}) | from_entries]),
        success: .success, meta: .meta }]'
    return 0
  fi
  why=$(printf '%s' "$body" | jq -r '.errors[0].message // empty' 2>/dev/null)
  if [ -n "$why" ]; then
    jq -cn --arg t "$why" '{error: {text: $t}}'
    printf '  !! 读库命令失败（本地接口，HTTP %s）：%s｜%s\n' "$code" "$(_d1_head "$1")" "$why" >&2
  else
    printf '  !! 读库命令失败（本地接口回的东西看不懂，HTTP %s）：%s｜收到的前 200 字：%s\n' \
      "$code" "$(_d1_head "$1")" "$(printf '%s' "$body" | head -c 200)" >&2
  fi
  return 1
}

_d1() {
  local out rc err why
  out=$(_d1_http "$1"); rc=$?
  if [ "$rc" -ne 2 ]; then
    [ -n "$out" ] && printf '%s\n' "$out"
    return "$rc"
  fi
  _d1_trace cli "$1"
  err=$(mktemp)
  out=$(npx wrangler d1 execute "$D1_NAME" --local ${D1_PERSIST:+--persist-to "$D1_PERSIST"} \
    --json --command "$1" 2>"$err")
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    why=$(printf '%s' "$out" | jq -r '.error.text // empty' 2>/dev/null)
    [ -n "$why" ] || why=$(grep -v -e 'Proxy environment variables' -e '^[[:space:]]*$' "$err" \
      | tail -3 | tr '\n' ' ' | cut -c1-300)
    printf '  !! 读库命令失败（退出码 %s）：%s｜%s\n' "$rc" "$(_d1_head "$1")" "${why:-没有任何报错输出}" >&2
  fi
  rm -f "$err"
  return "$rc"
}

# 原样的 JSON（调用方自己用 jq 取）
sql() { _d1 "$1"; }

# 第一行第一列；没有行时为空。读库失败时也为空，但 stderr 上有那行"!! 读库命令失败"，
# 并且退出码不为 0（和以前 pipefail 下的行为一致）。
one() {
  local out
  out=$(_d1 "$1") || return
  printf '%s\n' "$out" | jq -r '.[0].results[0] // {} | to_entries[0].value // empty'
}

# 只执行、不要结果
exec_sql() { _d1 "$1" > /dev/null; }
