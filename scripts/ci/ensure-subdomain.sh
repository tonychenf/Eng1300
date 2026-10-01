#!/usr/bin/env bash
# 账号还没有 workers.dev 子域名时注册一个。
#
# 需要：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID
# 写入 GITHUB_ENV：WORKERS_SUBDOMAIN
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来，正文一字未改）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e

SUB=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain" \
  | jq -r '.result.subdomain // empty')
if [ -z "$SUB" ]; then
  CAND="xlearn-$(echo "$CLOUDFLARE_ACCOUNT_ID" | cut -c1-8)"
  echo "账号还没有 workers.dev 子域名，尝试注册：$CAND"
  RESP=$(curl -sS -X PUT -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' --data "{\"subdomain\":\"$CAND\"}" \
    "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/workers/subdomain")
  if [ "$(echo "$RESP" | jq -r '.success')" != "true" ]; then
    echo "::error::注册 workers.dev 子域名失败，请手动在 Cloudflare 控制台 Workers 页面设置一次子域名后重跑。"
    echo "$RESP" | jq -c '.errors // .'
    exit 1
  fi
  SUB="$CAND"
fi
echo "workers.dev 子域名：$SUB"
echo "WORKERS_SUBDOMAIN=$SUB" >> "$GITHUB_ENV"
