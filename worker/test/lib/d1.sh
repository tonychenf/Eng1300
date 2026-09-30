# 各套件共用的读库助手（CR-M9）。套件自己先设好 D1_NAME，再 source 这个文件：
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
#   !! 读库命令失败（退出码 N）：<SQL 开头>｜<报错>
# run-all.sh 会把出现过这一行的套件单独点名，哪怕它的断言碰巧全绿。
# 不重试：重试会把"偶尔读不到"藏起来，而这类问题要先看得见才谈得上修。
#
# 报错在哪：SQL 错（没有这张表、违反约束）时 wrangler 退出码 1，报错是 stdout 上的
# {"error":{"text":…}}，stderr 里只有一句代理提示；wrangler 自己起不来时报错才在 stderr。
# 所以先取 stdout 的 .error.text，取不到再取 stderr 尾部。

_d1() {
  local out rc err why
  err=$(mktemp)
  out=$(npx wrangler d1 execute "$D1_NAME" --local ${D1_PERSIST:+--persist-to "$D1_PERSIST"} \
    --json --command "$1" 2>"$err")
  rc=$?
  [ -n "$out" ] && printf '%s\n' "$out"
  if [ "$rc" -ne 0 ]; then
    why=$(printf '%s' "$out" | jq -r '.error.text // empty' 2>/dev/null)
    [ -n "$why" ] || why=$(grep -v -e 'Proxy environment variables' -e '^[[:space:]]*$' "$err" \
      | tail -3 | tr '\n' ' ' | cut -c1-300)
    printf '  !! 读库命令失败（退出码 %s）：%s｜%s\n' "$rc" \
      "$(printf '%s' "$1" | jq -Rrs 'gsub("\\s+"; " ") | .[0:80]')" "${why:-没有任何报错输出}" >&2
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
