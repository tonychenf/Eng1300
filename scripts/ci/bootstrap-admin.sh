#!/usr/bin/env bash
# 用户表为空时建超级管理员 admin（/api/setup，凭刚轮换的 SETUP_TOKEN）。
#
# 需要：WORKER_URL、SETUP_TOKEN_VALUE、ADMIN_PASSWORD 和/或 ADMIN_PASS
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来，正文一字未改）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e

ADMIN_PASSWORD="${ADMIN_PASSWORD:-$ADMIN_PASS}"
if [ -z "$ADMIN_PASSWORD" ]; then
  echo "::warning::未设置仓库 Secret「ADMIN_PASSWORD」或「ADMIN_PASS」，跳过超级管理员初始化。"
  exit 0
fi
# 刚写入的 SETUP_TOKEN 需要一点时间同步到边缘节点，在此期间
# Worker 读到的还是旧值，会返回 403，因此这里要重试。
for i in $(seq 1 24); do
  CODE=$(curl -sS -m 30 -o /tmp/setup.json -w '%{http_code}' -X POST "$WORKER_URL/api/setup" \
    -H "X-Setup-Token: $SETUP_TOKEN_VALUE" -H 'Content-Type: application/json' \
    --data "$(jq -n --arg p "$ADMIN_PASSWORD" '{username:"admin",password:$p}')" 2>/dev/null || echo 000)
  case "$CODE" in
    201) echo "超级管理员 admin 创建成功。"; exit 0 ;;
    409) echo "用户表已有数据，之前已初始化过，跳过。"; exit 0 ;;
    403) echo "第 $i 次尝试：密钥尚未生效（403），10 秒后重试…" ;;
    *)   echo "第 $i 次尝试返回 $CODE，10 秒后重试…" ;;
  esac
  sleep 10
done
echo "::error::初始化超级管理员失败，最后一次响应："
cat /tmp/setup.json 2>/dev/null || true
exit 1
