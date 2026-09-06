#!/usr/bin/env bash
# 整条流水线只登录这一次：既少几次触发登录限流的机会，也让失败原因集中在一处。
# 两个 Secret 名字都认，按顺序各试一次。
#
# 需要环境变量：WORKER_URL、ADMIN_PASSWORD 和/或 ADMIN_PASS、GITHUB_ENV
set -uo pipefail

CANDIDATES=()
LAST_CODE=""
TOKEN=""
if [ -n "${ADMIN_PASSWORD:-}" ]; then CANDIDATES+=("ADMIN_PASSWORD"); fi
if [ -n "${ADMIN_PASS:-}" ] && [ "${ADMIN_PASS:-}" != "${ADMIN_PASSWORD:-}" ]; then CANDIDATES+=("ADMIN_PASS"); fi
if [ ${#CANDIDATES[@]} -eq 0 ]; then
  echo "::warning::未设置 ADMIN_PASSWORD 或 ADMIN_PASS，后续需要登录的步骤会跳过。"
  exit 0
fi

try_login() {
  local name="$1" secret="$2"
  local code
  code=$(curl -sS -m 30 -o /tmp/login.json -w '%{http_code}' -X POST "$WORKER_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(jq -n --arg p "$secret" '{username:"admin",password:$p}')" || echo 000)
  TOKEN=$(jq -r '.token // empty' /tmp/login.json 2>/dev/null || echo '')
  LAST_CODE="$code"
  if [ -n "$TOKEN" ]; then
    echo "用 $name 登录成功。"
    return 0
  fi
  echo "用 $name 登录返回 HTTP $code：$(jq -c '.' /tmp/login.json 2>/dev/null || cat /tmp/login.json)"
  return 1
}

for _round in 1 2 3; do
  for name in "${CANDIDATES[@]}"; do
    try_login "$name" "${!name}" && break 2
    # 429 是登录限流，锁定期 10 分钟，再试只会更糟
    if [ "$LAST_CODE" = "429" ]; then
      echo "::error::admin 被登录限流锁定。等待 10 分钟后重跑；本流水线会在登录前自动清一次锁定记录，所以重跑通常就能过。"
      exit 1
    fi
  done
  # 密码本身不对，重试也不会变对，只对网络或服务端错误重试
  case "$LAST_CODE" in 401|403) break ;; esac
  sleep 10
done

if [ -z "$TOKEN" ]; then
  echo "::error::管理员登录失败（最后一次 HTTP $LAST_CODE）。若是 401，说明 Secret 里的密码与线上 admin 的实际密码不一致。"
  exit 1
fi
echo "::add-mask::$TOKEN"
echo "ADMIN_TOKEN=$TOKEN" >> "$GITHUB_ENV"
echo "管理员登录成功。"
