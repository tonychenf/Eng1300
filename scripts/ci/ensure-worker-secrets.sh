#!/usr/bin/env bash
# 补齐 Worker 密钥：JWT_SECRET、ENCRYPTION_KEY 只在缺失时生成；SETUP_TOKEN 每次轮换。
#
# 在 worker/ 目录下跑（wrangler secret put 要读 wrangler.toml）。
# 需要：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、WORKER_NAME
# 写入 GITHUB_ENV：SETUP_TOKEN_VALUE
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来，正文一字未改）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e

EXISTING=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/scripts/$WORKER_NAME/secrets" \
  | jq -r '[.result[]?.name] | join(" ")')
echo "已存在的密钥：${EXISTING:-（无）}"

if ! echo " $EXISTING " | grep -q " JWT_SECRET "; then
  printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put JWT_SECRET
  echo "已生成并写入 JWT_SECRET。"
fi

# AI Key 的加密密钥。一旦轮换，已存的密文就解不开了，所以只在缺失时生成。
if ! echo " $EXISTING " | grep -q " ENCRYPTION_KEY "; then
  printf '%s' "$(openssl rand -hex 32)" | npx wrangler secret put ENCRYPTION_KEY
  echo "已生成并写入 ENCRYPTION_KEY。"
fi

# SETUP_TOKEN 每次运行都轮换成新值：它只在用户表为空时才有用，
# 这样即使某次初始化失败，下一次运行也仍然知道令牌、可以重试。
TOKEN_VALUE=$(openssl rand -hex 24)
echo "::add-mask::$TOKEN_VALUE"
printf '%s' "$TOKEN_VALUE" | npx wrangler secret put SETUP_TOKEN
echo "SETUP_TOKEN_VALUE=$TOKEN_VALUE" >> "$GITHUB_ENV"
