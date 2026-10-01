#!/usr/bin/env bash
# 删一个 D1 库——**只删演练的一次性库**（CR-M6）。名字不是 xlearn-drill-<运行编号>-<字母> 一律拒绝，
# 而且按名字查到的 id 必须和传进来的一致：流水线手里握着能删线上库的 Token，自动化里唯一的删库
# 动作只能有这一个出口、只认这一种名字。线上库和恢复出来的新库，删不删由人在 Cloudflare 后台决定。
#
# 用法：d1-delete-db.sh <库名> <库 id>
# 需要：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID；可选 CF_API_BASE
set -euo pipefail
NAME="${1:-}"; ID="${2:-}"
if ! [[ "$NAME" =~ ^xlearn-drill-[0-9]+-[a-z]$ ]]; then
  echo "::error::拒绝删除「$NAME」：自动化只删演练的一次性库（xlearn-drill-<运行编号>-<字母>）" >&2; exit 1
fi
[ -n "$ID" ] || { echo "::error::缺库 id" >&2; exit 1; }
BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
LIST=$(curl -sS "${AUTH[@]}" "$BASE?name=$NAME")
FOUND=$(jq -r --arg n "$NAME" '[.result[]? | select(.name == $n)][0].uuid // empty' <<<"$LIST" 2>/dev/null)
[ "$FOUND" = "$ID" ] || { echo "::error::「$NAME」查到的 id 是「$FOUND」，和要删的「$ID」不一致，不删" >&2; exit 1; }
RESP=$(curl -sS -X DELETE "${AUTH[@]}" "$BASE/$ID")
[ "$(jq -r '.success' <<<"$RESP" 2>/dev/null)" = "true" ] \
  || { echo "::error::删库失败：$(jq -c '.errors // .' <<<"$RESP" 2>/dev/null | head -c 300)" >&2; exit 1; }
echo "删掉了一次性库 $NAME"
