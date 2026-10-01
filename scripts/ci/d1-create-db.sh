#!/usr/bin/env bash
# 新建一个 D1 库，打印它的 id（CR-M6）。恢复（备份导进新库）和演练用。同名的库已经存在就拒绝：
# 恢复时"新库"必须是新的，演练的库名带着运行编号也不该撞上。
#
# 用法：ID=$(bash scripts/ci/d1-create-db.sh <库名>)
# 需要：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID；可选 CF_API_BASE（本地测试指向假接口）
set -euo pipefail
NAME="${1:-}"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{2,62}$ ]] || { echo "::error::库名不合法：「$NAME」" >&2; exit 1; }
BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database"
AUTH=(-H "Authorization: Bearer $CLOUDFLARE_API_TOKEN")
LIST=$(curl -sS "${AUTH[@]}" "$BASE?name=$NAME")
[ "$(jq -r '.success' <<<"$LIST" 2>/dev/null)" = "true" ] \
  || { echo "::error::读库列表失败：$(jq -c '.errors // .' <<<"$LIST" 2>/dev/null | head -c 300)" >&2; exit 1; }
if [ -n "$(jq -r --arg n "$NAME" '[.result[] | select(.name == $n)][0].uuid // empty' <<<"$LIST")" ]; then
  echo "::error::已经有一个叫「$NAME」的库了，换一个名字" >&2; exit 1
fi
RESP=$(curl -sS -X POST "${AUTH[@]}" -H 'Content-Type: application/json' --data "{\"name\":\"$NAME\"}" "$BASE")
ID=$(jq -r 'if .success then .result.uuid // empty else empty end' <<<"$RESP" 2>/dev/null)
[ -n "$ID" ] || { echo "::error::建库失败：$(jq -c '.errors // .' <<<"$RESP" 2>/dev/null | head -c 300)" >&2; exit 1; }
echo "新建了库 $NAME（$ID）" >&2
printf '%s\n' "$ID"
