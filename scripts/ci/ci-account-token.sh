#!/usr/bin/env bash
# 流水线自己的管理员账号（运-2，2026-10-07 用户定的）：每次运行给它写一个新的随机密码，再用它登录取令牌。
#
# 以前流水线用 Secret 里的密码登录 admin：管理员在后台改了自己的密码（需求文档建议首次登录就改），
# 下一次部署就登录不上、线上验证整段红；admin 被人试错锁住，也得每次部署替它清锁定。
# 现在 admin 的密码只归人管，流水线用 ci_deploy：
#   - 密码每次运行现生成（48 位十六进制），只在这次运行的内存里，不存任何地方、不打进日志；
#   - 直接写进库（bcrypt 哈希），同时把它的令牌版本加一——上一次运行的令牌当场作废；
#   - 角色是超级管理员（本平台只有这一种管理角色），不算学员，不进学员统计。
# 后台里改它、停用它都没用：下一次运行会把它改回来。要让流水线停下，删掉 CLOUDFLARE_API_TOKEN。
#
# 需要：D1_NAME、WORKER_URL、GITHUB_ENV；--remote 时还要 CLOUDFLARE_API_TOKEN（wrangler 读）
# 写入 GITHUB_ENV：ADMIN_TOKEN（沿用这个名字，后面各步不用改）、ADMIN_LOGIN_AT（登录那一刻，
#   线上验证的写入哨兵拿它和这个账号的最后登录时间比）、CI_ACCOUNT（哨兵按这个名字找账号）
# 用法：ci-account-token.sh --remote|--local
set -euo pipefail
case "${1:-}" in
  --remote) TARGET=(--remote --yes) ;;
  --local)  TARGET=(--local) ;;
  *) echo "::error::用法：ci-account-token.sh --remote|--local"; exit 1 ;;
esac
: "${D1_NAME:?缺少 D1_NAME}" "${WORKER_URL:?缺少 WORKER_URL}" "${GITHUB_ENV:?缺少 GITHUB_ENV}"
ACCOUNT=ci_deploy
HERE=$(cd "$(dirname "$0")" && pwd)
WORKER_DIR="$HERE/../../worker"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT

PASSWORD=$(openssl rand -hex 24)
# 在 GitHub 上先登记成要涂掉的值，万一后面哪一步把它带进了输出也只会显示 ***
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::add-mask::$PASSWORD"; fi

# 和接口里一样的算法与代价（worker/src/index.js：bcryptjs，10）。密码经环境变量传给 node，不上命令行
HASH=$(cd "$WORKER_DIR" && CI_PW="$PASSWORD" node -e \
  "process.stdout.write(require('bcryptjs').hashSync(process.env.CI_PW, 10))")
# bcrypt 哈希只含 [./$A-Za-z0-9]，拼进单引号里是安全的；不是这个形状就别往库里写
[[ "$HASH" =~ ^\$2[aby]\$10\$[./A-Za-z0-9]{53}$ ]] || { echo "::error::生成的密码哈希形状不对（长度 ${#HASH}），不写库"; exit 1; }

# 写进文件交给 --file：哈希不出现在命令行和日志里
cat > "$T/account.sql" <<SQL
INSERT INTO users (username, password_hash, role)
  VALUES ('$ACCOUNT', '$HASH', 'SUPER_ADMIN')
  ON CONFLICT(username) DO UPDATE SET
    password_hash = excluded.password_hash,
    role = 'SUPER_ADMIN',
    disabled = 0,
    token_version = token_version + 1;
DELETE FROM login_attempts WHERE username = '$ACCOUNT' OR substr(username, 1, ${#ACCOUNT} + 1) = '$ACCOUNT|';
SQL
(cd "$WORKER_DIR" && npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" --file="$T/account.sql" > "$T/sql.out" 2>&1) || {
  echo "::error::写流水线账号失败："; tail -20 "$T/sql.out" | sed 's/^/    /'; exit 1
}

# 登录。写库和登录之间没有缓存，失败只可能是网络或服务端的错——重试三次
TOKEN=""; CODE=""
for _ in 1 2 3; do
  LOGIN_AT=$(date -u +%s)
  CODE=$(curl -sS -m 30 -o "$T/login.json" -w '%{http_code}' -X POST "$WORKER_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(CI_PW="$PASSWORD" jq -n --arg u "$ACCOUNT" '{username:$u,password:env.CI_PW}')" || echo 000)
  TOKEN=$(jq -r '.token // empty' "$T/login.json" 2>/dev/null || true)
  [ -n "$TOKEN" ] && break
  if grep -q 'storage_quota_exceeded' "$T/login.json" 2>/dev/null; then
    echo "::error::D1 今日写入额度已用尽（世界时零点、北京时间早八点恢复）；登录要写入，现在过不去。"
    exit 1
  fi
  sleep 5
done
if [ -z "$TOKEN" ]; then
  echo "::error::流水线账号登录失败（HTTP $CODE）：$(jq -c '{error, message}' "$T/login.json" 2>/dev/null || head -c 200 "$T/login.json")"
  exit 1
fi
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then echo "::add-mask::$TOKEN"; fi
{
  echo "ADMIN_TOKEN=$TOKEN"
  echo "ADMIN_LOGIN_AT=$LOGIN_AT"
  echo "CI_ACCOUNT=$ACCOUNT"
} >> "$GITHUB_ENV"
echo "流水线账号 $ACCOUNT 登录成功（密码本次现生成，未保存）。"
