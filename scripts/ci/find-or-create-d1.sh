#!/usr/bin/env bash
# 按库名找 D1 数据库。找不到时，只有明说了"允许新建"才建（CR-M15）。
#
# 需要：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、D1_NAME
# 可选：ALLOW_CREATE_DB=true（手动触发部署时勾「首次部署，允许新建数据库」才是 true）
#       CF_API_BASE（默认 https://api.cloudflare.com/client/v4；本地测试 d1-ops-guard 指向假接口）
# 写入 GITHUB_ENV：D1_DATABASE_ID、D1_JUST_CREATED（true / false）
#
# 以前找不到就建，每次部署都这样。库要是被人在 Cloudflare 后台删了、或者 API Token 换到了另一个
# 账号，下一次推送就会建一个空库顶上：导题库、建管理员和学员，线上验证照样全绿（部署前 0 章已发布、
# 部署后也是 0 章），学员的作答记录和后台确认过的答案全没了，只有日志里一行「正在创建」。
# 新建只该发生在第一次上线；其余时候库不见了是事故，要停下来走恢复手册（docs/数据恢复手册.md）。
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来，正文一字未改）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e

BASE="${CF_API_BASE:-https://api.cloudflare.com/client/v4}/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database"
LIST=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "$BASE?name=$D1_NAME")
if [ "$(echo "$LIST" | jq -r '.success')" != "true" ]; then
  echo "::error::读取 D1 数据库列表失败。请确认 API Token 含有 D1:Edit 权限（Cloudflare 后台 → API Tokens → 编辑该 Token → 添加 Account / D1 / Edit）。"
  echo "$LIST" | jq -c '.errors // .'
  exit 1
fi
DB_ID=$(echo "$LIST" | jq -r --arg n "$D1_NAME" '[.result[] | select(.name==$n)][0].uuid // empty')
CREATED=false
if [ -z "$DB_ID" ]; then
  if [ "${ALLOW_CREATE_DB:-false}" != "true" ]; then
    echo "::error::找不到数据库「$D1_NAME」，部署停在这里，没有新建、也没有动任何东西。"
    echo "::error::第一次上线：手动触发部署，勾上「首次部署，允许新建数据库」。库被删了或者账号换了：先别部署，照 docs/数据恢复手册.md 处理——新建一个空库顶上会让站点看起来一切正常，学员数据却全没了。"
    exit 1
  fi
  echo "数据库不存在，按要求新建（ALLOW_CREATE_DB=true）：$D1_NAME"
  CREATE=$(curl -sS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    -H 'Content-Type: application/json' --data "{\"name\":\"$D1_NAME\"}" "$BASE")
  if [ "$(echo "$CREATE" | jq -r '.success')" != "true" ]; then
    echo "::error::创建 D1 数据库失败。"
    echo "$CREATE" | jq -c '.errors // .'
    exit 1
  fi
  DB_ID=$(echo "$CREATE" | jq -r '.result.uuid')
  CREATED=true
fi
echo "D1 database id: $DB_ID"
echo "D1_DATABASE_ID=$DB_ID" >> "$GITHUB_ENV"
echo "D1_JUST_CREATED=$CREATED" >> "$GITHUB_ENV"
