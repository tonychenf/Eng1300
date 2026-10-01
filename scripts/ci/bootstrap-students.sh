#!/usr/bin/env bash
# 建学员账号 T001–T010，已存在的跳过。
#
# 需要：WORKER_URL、ADMIN_TOKEN、STUDENT_PASSWORD
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来，正文一字未改）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e

if [ -z "${ADMIN_TOKEN:-}" ] || [ -z "$STUDENT_PASSWORD" ]; then
  echo "::warning::缺少管理员令牌或 STUDENT_PASSWORD，跳过学员账号初始化。"
  exit 0
fi
TOKEN="$ADMIN_TOKEN"
for i in $(seq -w 1 10); do
  NAME="T0$i"
  CODE=$(curl -sS -m 30 -o /tmp/user.json -w '%{http_code}' -X POST "$WORKER_URL/api/admin/users" \
    -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg u "$NAME" --arg p "$STUDENT_PASSWORD" '{username:$u,password:$p}')")
  case "$CODE" in
    201) echo "  已创建 $NAME" ;;
    409) echo "  $NAME 已存在，跳过" ;;
    *)   echo "::error::创建 $NAME 失败（HTTP $CODE）"; cat /tmp/user.json; exit 1 ;;
  esac
done
