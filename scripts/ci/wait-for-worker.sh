#!/usr/bin/env bash
# 轮询健康检查，等新部署的 Worker 能访问（新子域名要等 HTTPS 证书签发）。
#
# 需要：WORKER_NAME、WORKERS_SUBDOMAIN
# 写入 GITHUB_ENV：WORKER_URL
#
# 原来内联在 deploy-worker.yml 里（CR-M8 搬出来，正文一字未改）：流水线日志有长度上限，
# 内联的大段 shell 没法在本地跑、也没法测。
#
# set -e 不是新加的规矩：YAML 里不写 shell: 的 run 步骤，GitHub 用 `bash -e {0}` 执行，
# 任何一条命令失败整步就停。搬进脚本后由 `bash 脚本` 执行，默认不带 -e——不补这一行，
# 原来会当场停下的失败就会被跳过去，接着往下跑。
set -e

URL="https://$WORKER_NAME.$WORKERS_SUBDOMAIN.workers.dev"
echo "WORKER_URL=$URL" >> "$GITHUB_ENV"
# 新注册的 workers.dev 子域名要等 Cloudflare 签发 HTTPS 证书，
# 这期间 TLS 握手会直接失败，需要耐心轮询。
for i in $(seq 1 40); do
  CODE=$(curl -sS -m 15 -o /dev/null -w '%{http_code}' "$URL/api/health" 2>/dev/null || echo 000)
  if [ "$CODE" = "200" ]; then
    echo "服务已就绪（第 $i 次探测）。"
    exit 0
  fi
  echo "第 $i 次探测返回 $CODE，15 秒后重试…"
  sleep 15
done
echo "::error::等待约 10 分钟后服务仍不可访问。新子域名的 HTTPS 证书签发有时需要更久，稍后重跑本流水线即可。"
exit 1
