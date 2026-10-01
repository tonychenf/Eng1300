#!/usr/bin/env bash
# 按库名找 D1 数据库，没有就建。
#
# 需要：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、D1_NAME
# 写入 GITHUB_ENV：D1_DATABASE_ID
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来，正文一字未改）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e

BASE="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database"
LIST=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE?name=$D1_NAME")
if [ "$(echo "$LIST" | jq -r '.success')" != "true" ]; then
  echo "::error::读取 D1 数据库列表失败。请确认 API Token 含有 D1:Edit 权限（Cloudflare 后台 → API Tokens → 编辑该 Token → 添加 Account / D1 / Edit）。"
  echo "$LIST" | jq -c '.errors // .'
  exit 1
fi
DB_ID=$(echo "$LIST" | jq -r --arg n "$D1_NAME" '[.result[] | select(.name==$n)][0].uuid // empty')
if [ -z "$DB_ID" ]; then
  echo "数据库不存在，正在创建：$D1_NAME"
  CREATE=$(curl -sS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' --data "{\"name\":\"$D1_NAME\"}" "$BASE")
  if [ "$(echo "$CREATE" | jq -r '.success')" != "true" ]; then
    echo "::error::创建 D1 数据库失败。"
    echo "$CREATE" | jq -c '.errors // .'
    exit 1
  fi
  DB_ID=$(echo "$CREATE" | jq -r '.result.uuid')
fi
echo "D1 database id: $DB_ID"
echo "D1_DATABASE_ID=$DB_ID" >> "$GITHUB_ENV"
