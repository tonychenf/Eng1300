#!/usr/bin/env bash
# 确认 API Token 有效，并拿到 Cloudflare Account ID（显式配置的 Secret → 账号列表 → 域名反查）。
#
# 需要：CLOUDFLARE_API_TOKEN；可选 ACCOUNT_ID_SECRET
# 写入 GITHUB_ENV：CLOUDFLARE_ACCOUNT_ID
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来，正文一字未改）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e

VERIFY=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/user/tokens/verify")
echo "Token 状态：$(echo "$VERIFY" | jq -r '.result.status // "unknown"')"
if [ "$(echo "$VERIFY" | jq -r '.success')" != "true" ]; then
  echo "::error::Cloudflare 拒绝了这个 API Token，请检查是否填错或已过期。"
  echo "$VERIFY" | jq -c '.errors // .'
  exit 1
fi

ACCOUNT_ID=""
# 1) 优先使用显式配置的 Account ID
if [ -n "$ACCOUNT_ID_SECRET" ]; then
  ACCOUNT_ID="$ACCOUNT_ID_SECRET"
  echo "使用 Secret 中配置的 Account ID。"
fi

# 2) 否则尝试列出账号（需要 Token 具备 Account Settings:Read 权限）
if [ -z "$ACCOUNT_ID" ]; then
  RESP=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/accounts")
  ACCOUNT_ID=$(echo "$RESP" | jq -r '.result[0].id // empty')
  [ -n "$ACCOUNT_ID" ] && echo "通过账号列表接口自动识别到账号。"
fi

# 3) 再退一步：从域名（zone）信息里反查所属账号
if [ -z "$ACCOUNT_ID" ]; then
  ZONES=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4/zones")
  ACCOUNT_ID=$(echo "$ZONES" | jq -r '.result[0].account.id // empty')
  [ -n "$ACCOUNT_ID" ] && echo "通过域名信息反查到账号。"
fi

if [ -z "$ACCOUNT_ID" ]; then
  echo "::error::拿不到 Cloudflare Account ID。这个 Token 没有 Account Settings:Read 权限，也查不到任何域名。请添加仓库 Secret「CLOUDFLARE_ACCOUNT_ID」：登录 Cloudflare 控制台 → 左侧 Workers & Pages，页面右侧或浏览器地址栏 dash.cloudflare.com/<这一串就是 Account ID>/workers。"
  exit 1
fi

echo "::add-mask::$ACCOUNT_ID"
echo "CLOUDFLARE_ACCOUNT_ID=$ACCOUNT_ID" >> "$GITHUB_ENV"
