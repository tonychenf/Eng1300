#!/usr/bin/env bash
# 改进阶段 2 第三期：AI 拆题导入暂存照片用的 KV 命名空间。按名字找，找不到就建，再把 id 填进 wrangler.toml。
#
# 用法：find-or-create-kv.sh <wrangler.toml 路径>
# 需要：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID；可选 CF_API_BASE（本地测试 d1-ops-guard 指向假接口）、
#       KV_TITLE（默认 <worker 名>-import-images）
#
# 和 D1 不同，找不到就建、不用"允许新建"那个开关：这里只放排队等识别的照片，识别完就删、一天过期，
# 新建一个空的顶上不会丢任何东西（D1 那边新建空库会让学员数据"消失"，所以要人明说）。
#
# API Token 没有 KV 权限时停下、说清楚缺哪一项——这时 D1 还一行都没动（这一步排在备份、迁移之前）。
set -e
TOML="${1:?用法：$0 <wrangler.toml 路径>}"
[ -f "$TOML" ] || { echo "::error::找不到 $TOML"; exit 1; }
WORKER=$(grep -E '^name *=' "$TOML" | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
TITLE="${KV_TITLE:-${WORKER}-import-images}"
BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces"

no_permission() {
  echo "::error::读写 KV 命名空间被拒绝：部署用的 API Token 还没有 KV 权限。"
  echo "::error::到 Cloudflare 后台 → 右上角头像 → My Profile → API Tokens → 编辑部署用的那个 Token → Permissions 加一项「Account｜Workers KV Storage｜Edit」→ 保存，再重新运行。Token 的值不变，GitHub 里不用改。"
  echo "::error::（AI 拆题导入要用 KV 暂存排队等识别的照片，识别完立刻删。这一步失败时数据库还一行都没动。）"
}

ID=""
PAGE=1
while :; do
  LIST=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE?per_page=100&page=$PAGE")
  if [ "$(echo "$LIST" | jq -r '.success')" != "true" ]; then
    no_permission
    echo "$LIST" | jq -c '.errors // .' 2>/dev/null || echo "$LIST" | head -c 300
    exit 1
  fi
  ID=$(echo "$LIST" | jq -r --arg t "$TITLE" '[.result[] | select(.title == $t)][0].id // empty')
  [ -n "$ID" ] && break
  [ "$(echo "$LIST" | jq -r '.result | length')" -lt 100 ] && break
  PAGE=$((PAGE + 1))
done

if [ -z "$ID" ]; then
  echo "KV 命名空间「$TITLE」不存在，新建（只放排队等识别的照片，识别完就删）"
  CREATE=$(curl -sS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -nc --arg t "$TITLE" '{title:$t}')" "$BASE")
  if [ "$(echo "$CREATE" | jq -r '.success')" != "true" ]; then
    no_permission
    echo "$CREATE" | jq -c '.errors // .' 2>/dev/null || echo "$CREATE" | head -c 300
    exit 1
  fi
  ID=$(echo "$CREATE" | jq -r '.result.id')
fi
[ -n "$ID" ] && [ "$ID" != "null" ] || { echo "::error::取不到 KV 命名空间的 id"; exit 1; }

# 填进 wrangler.toml：IMPORT_IMAGES 那一项已经有 id 就换掉，没有就加在 binding 那一行后面。
# 只认这一个 binding，别的 KV（将来要是有）不碰。
python3 - "$TOML" "$ID" <<'PY'
import re, sys
path, kid = sys.argv[1], sys.argv[2]
s = open(path, encoding='utf-8').read()
blocks = re.split(r'(?m)^(?=\[)', s)
hit = 0
for i, b in enumerate(blocks):
    if b.startswith('[[kv_namespaces]]') and re.search(r'(?m)^binding\s*=\s*"IMPORT_IMAGES"\s*$', b):
        if re.search(r'(?m)^id\s*=', b):
            b = re.sub(r'(?m)^id\s*=.*$', f'id = "{kid}"', b)
        else:
            b = re.sub(r'(?m)^(binding\s*=\s*"IMPORT_IMAGES"\s*)$', rf'\1\nid = "{kid}"', b)
        blocks[i] = b
        hit += 1
if hit != 1:
    sys.exit(f'wrangler.toml 里 binding = "IMPORT_IMAGES" 的 [[kv_namespaces]] 有 {hit} 个，应当正好 1 个')
open(path, 'w', encoding='utf-8').write(''.join(blocks))
PY
echo "KV 命名空间 $TITLE：$ID（已填进 $TOML）"
[ -n "${GITHUB_ENV:-}" ] && echo "KV_IMPORT_IMAGES_ID=$ID" >> "$GITHUB_ENV"
exit 0
