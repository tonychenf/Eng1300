#!/usr/bin/env bash
# 把一串查询（一行一句）分批发给 D1，每批不超过 D1_SQL_BUDGET 字节（默认 40000），结果按原顺序合成一个数组。
#
# 为什么要分批（2026-10-02）：线上的 `wrangler d1 execute --command` 把整条命令原样发给 D1；本地的会先拆成
# 一句一句再执行（翻 wrangler 源码确认的），所以 D1 的长度上限本地永远跑不出来。D1 文档写着一条 SQL 最长
# 100 KB；命令行的一个参数最长 128 KB（Linux 的 MAX_ARG_STRLEN，实测 131072 字节就报 Argument list too long）。
# 备份时查"会被导出改写的文本"，32 张表拼成一条是 111 KB，两个上限都贴着；以前的核对三把补回的原文
# 十六进制整个塞进一条命令，文本越多越长。
#
# 单独一句就超过上限的，自成一批（拆不开；调用方要保证单句不会长到那个地步）。
#
# 用法：d1-query-chunks.sh --remote|--local <库名> <语句文件（一行一句）>
# 输出（stdout）：和 wrangler d1 execute --json 一样的数组，每句一项，顺序和语句文件一致
# stderr 最后一行：「分批：分 N 批（最长 M 字节）」；失败时写的是哪一批、D1 的报错
# 可选：WRANGLER_DIR（在哪个目录跑 wrangler，默认仓库的 worker/）、D1_SQL_BUDGET
set -euo pipefail
WORKER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../worker" && pwd)"
case "${1:-}" in
  --remote) MODE=--remote ;;
  --local)  MODE=--local ;;
  *) echo "用法：d1-query-chunks.sh --remote|--local <库名> <语句文件>" >&2; exit 1 ;;
esac
DB="${2:-}"; FILE="${3:-}"
[ -n "$DB" ] || { echo "缺库名" >&2; exit 1; }
[ -f "$FILE" ] || { echo "语句文件不存在：$FILE" >&2; exit 1; }
BUDGET="${D1_SQL_BUDGET:-40000}"
[[ "$BUDGET" =~ ^[1-9][0-9]*$ ]] || { echo "D1_SQL_BUDGET 不是正整数：$BUDGET" >&2; exit 1; }

C=$(mktemp -d)
trap 'rm -rf "$C"' EXIT
# 按字节切（LC_ALL=C 下 awk 的 length 是字节数），空行跳过。一批里的语句用换行连起来，所以每句多算 1 字节
LC_ALL=C awk -v budget="$BUDGET" -v dir="$C" '
  length($0) == 0 { next }
  {
    n = length($0) + 1
    if (size > 0 && size + n > budget) { close(file); c++; size = 0 }
    file = sprintf("%s/%05d.sql", dir, c)
    print > file
    size += n
  }' "$FILE"
NSTMT=$(LC_ALL=C awk 'length($0) > 0' "$FILE" | wc -l)
shopt -s nullglob
CHUNKS=("$C"/[0-9]*.sql)
NB=${#CHUNKS[@]}
if [ "$NB" -eq 0 ]; then echo '[]'; echo "分批：没有语句" >&2; exit 0; fi

cd "${WRANGLER_DIR:-$WORKER}"
MAXB=0; i=0
for f in "${CHUNKS[@]}"; do
  i=$((i + 1))
  SQL=$(cat "$f")
  B=$(printf '%s' "$SQL" | wc -c)
  [ "$B" -le "$MAXB" ] || MAXB=$B
  # 失败时 wrangler 把错误写在 stdout（{"error":{"text":…}}），stderr 里多半只有代理告警，两边都带出来
  if ! npx wrangler d1 execute "$DB" "$MODE" --json --command "$SQL" > "$C/out-$i.json" 2> "$C/err-$i.txt"; then
    echo "第 $i/$NB 批（$B 字节）失败：$(jq -r '.error.text // empty' "$C/out-$i.json" 2>/dev/null | head -c 300) $(tail -2 "$C/err-$i.txt" | tr '\n' ' ' | head -c 300)" >&2
    exit 1
  fi
done

OUTS=(); for ((k = 1; k <= NB; k++)); do OUTS+=("$C/out-$k.json"); done
jq -s 'if all(.[]; type == "array") then add else error("有一批返回的不是数组") end' "${OUTS[@]}" > "$C/all.json" \
  || { echo "合并各批的结果失败" >&2; exit 1; }
GOT=$(jq 'length' "$C/all.json")
[ "$GOT" = "$NSTMT" ] || { echo "发了 $NSTMT 句，D1 回了 $GOT 个结果，对不上" >&2; exit 1; }
cat "$C/all.json"
echo "分批：分 $NB 批（最长 $MAXB 字节）" >&2
