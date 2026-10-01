#!/usr/bin/env bash
# 打印一个库里每张表的行数，JSON：{"表名": 行数, ...}（CR-M6）。恢复前后对比、演练断言都用它。
# 不数 SQLite 和 D1 自己的内部表（sqlite_*、_cf_*）。读不到就失败，不打印空对象——
# 空对象会被当成"这个库一张表都没有"。
#
# 用法：d1-table-counts.sh --remote|--local <库名>
# 可选：WRANGLER_DIR（默认仓库的 worker/）
set -euo pipefail
WORKER="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../worker" && pwd)"
case "${1:-}" in
  --remote) TARGET=(--remote) ;;
  --local)  TARGET=(--local) ;;
  *) echo "::error::用法：d1-table-counts.sh --remote|--local <库名>" >&2; exit 1 ;;
esac
DB="${2:-}"; [ -n "$DB" ] || { echo "::error::缺库名" >&2; exit 1; }
cd "${WRANGLER_DIR:-$WORKER}"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT

q() {  # 跑一条（或几条）查询，只要 stdout 里的 JSON
  # 失败时 wrangler 加了 --json 会把错误写在 stdout（{"error":{"text":…}}），stderr 里只有代理之类的告警，
  # 两边都带出来
  if ! npx wrangler d1 execute "$DB" "${TARGET[@]}" --json --command "$1" > "$T/out.json" 2> "$T/err.log"; then
    echo "::error::读库失败（$DB）：$(jq -r '.error.text // empty' "$T/out.json" 2>/dev/null | head -c 300) $(tail -3 "$T/err.log" | tr '\n' ' ' | head -c 300)" >&2
    return 1
  fi
  jq -e 'type == "array" and all(.[]; .results | type == "array")' "$T/out.json" >/dev/null 2>&1 \
    || { echo "::error::读库返回的不是结果数组（前 200 字：$(head -c 200 "$T/out.json")）" >&2; return 1; }
}

q "SELECT name FROM sqlite_master WHERE type = 'table'
     AND substr(name, 1, 7) <> 'sqlite_' AND substr(name, 1, 4) <> '_cf_' ORDER BY name;"
mapfile -t TABLES < <(jq -r '.[0].results[].name' "$T/out.json")
if [ "${#TABLES[@]}" -eq 0 ]; then echo '{}'; exit 0; fi   # 真的一张表都没有（新建的空库）
# 不用 UNION ALL：D1 限制复合查询的项数，三十几张表一条 UNION ALL 会报 too many terms in compound SELECT。
# 改成每条语句十个标量子查询（一行十列），几条语句一次发出去。
SQL=""; i=0
for t in "${TABLES[@]}"; do
  [[ "$t" =~ ^[A-Za-z0-9_]+$ ]] || { echo "::error::表名不认识：$t" >&2; exit 1; }
  if [ $(( i % 10 )) -eq 0 ]; then SQL="${SQL:+$SQL; }SELECT "; else SQL="$SQL, "; fi
  SQL="$SQL(SELECT COUNT(*) FROM \"$t\") AS \"$t\""
  i=$((i + 1))
done
q "$SQL;"
jq -c '[.[].results[0]] | add' "$T/out.json"
