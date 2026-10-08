#!/usr/bin/env bash
# 把 admin 的密码重置成仓库 Secret 里的那个（运-2，2026-10-07）。由手动流水线 admin-reset.yml 调用。
#
# 以前忘了 admin 密码没有出路：需求文档写"重新运行初始化脚本"，可初始化脚本见到用户表里有人就 409 跳过。
# 用法：先在 GitHub 的 Secret「ADMIN_PASSWORD」里填上新密码（Secret 只能写不能读，自己另存一份），
# 再手动触发 admin-reset.yml。密码从不出现在日志里——仓库是公开的，运行日志和手动触发时填的参数谁都看得见，
# 所以新密码只能经 Secret 传进来。
#
# 做三件事：admin 的密码换成新的、解除停用；令牌版本加一（所有已登录的会话下线）；清掉 admin 的登录失败计数。
# 有 WORKER_URL 时再用新密码真登录一次，证明换上了。
# 需要：D1_NAME、ADMIN_PASSWORD（或 ADMIN_PASS）；--remote 时还要 CLOUDFLARE_API_TOKEN
# 用法：reset-admin-password.sh --remote|--local
set -euo pipefail
case "${1:-}" in
  --remote) TARGET=(--remote --yes) ;;
  --local)  TARGET=(--local) ;;
  *) echo "::error::用法：reset-admin-password.sh --remote|--local"; exit 1 ;;
esac
: "${D1_NAME:?缺少 D1_NAME}"
NEW_PW="${ADMIN_PASSWORD:-${ADMIN_PASS:-}}"
if [ -z "$NEW_PW" ]; then
  echo "::error::Secret「ADMIN_PASSWORD」是空的。先到 Settings → Secrets and variables → Actions 填上新密码，再触发这条流水线。"
  exit 1
fi
# 不打 ::add-mask::——新密码来自 Secret，GitHub 本来就替它打码；再打一遍等于把明文写进标准输出，
# 指望运行器把那一行吞掉（第一版这么写，deploy-local 在 CI 里照出"日志里有新密码"）
# 和后台改密码同一条规矩（worker/src/index.js）：不然重置成功了，自己再改一次却被拒
if [ ${#NEW_PW} -lt 8 ] || ! [[ "$NEW_PW" =~ [A-Za-z] ]] || ! [[ "$NEW_PW" =~ [0-9] ]]; then
  echo "::error::Secret 里的新密码不合规矩：至少 8 位，并且同时有字母和数字（长度 ${#NEW_PW}）。没有改动任何东西。"
  exit 1
fi
HERE=$(cd "$(dirname "$0")" && pwd)
WORKER_DIR="$HERE/../../worker"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
d1() { (cd "$WORKER_DIR" && npx wrangler d1 execute "$D1_NAME" "${TARGET[@]}" "$@"); }

# 先确认有 admin：一行都没改上的 UPDATE 不报错，"重置成功"就成了假话
N=$(d1 --json --command "SELECT COUNT(*) AS n FROM users WHERE username = 'admin'" 2>/dev/null \
  | jq -r '.[0].results[0].n // empty' 2>/dev/null || true)
if [ "$N" != "1" ]; then
  echo "::error::库里找不到 admin（查到 ${N:-读不出来}）。新库请先跑一次部署（Bootstrap super admin），不要用这条流水线。"
  exit 1
fi

HASH=$(cd "$WORKER_DIR" && NEW_PW="$NEW_PW" node -e \
  "process.stdout.write(require('bcryptjs').hashSync(process.env.NEW_PW, 10))")
[[ "$HASH" =~ ^\$2[aby]\$10\$[./A-Za-z0-9]{53}$ ]] || { echo "::error::生成的密码哈希形状不对（长度 ${#HASH}），不写库"; exit 1; }
cat > "$T/reset.sql" <<SQL
UPDATE users SET password_hash = '$HASH', disabled = 0, token_version = token_version + 1
 WHERE username = 'admin';
SQL
# 清锁定和部署时用的是同一份规则（按「用户名|IP」前缀清）
cat "$WORKER_DIR/sql/clear-admin-lockout.sql" >> "$T/reset.sql"
d1 --file="$T/reset.sql" > "$T/sql.out" 2>&1 || { echo "::error::写库失败："; tail -20 "$T/sql.out" | sed 's/^/    /'; exit 1; }
echo "admin 的密码已换成 Secret 里的那个；已登录的会话全部下线；登录失败计数已清。"

if [ -n "${WORKER_URL:-}" ]; then
  CODE=$(curl -sS -m 30 -o "$T/login.json" -w '%{http_code}' -X POST "$WORKER_URL/api/auth/login" \
    -H 'Content-Type: application/json' \
    --data "$(NEW_PW="$NEW_PW" jq -n '{username:"admin",password:env.NEW_PW}')" || echo 000)
  if [ -n "$(jq -r '.token // empty' "$T/login.json" 2>/dev/null)" ]; then
    echo "用新密码登录 admin 成功。"
  else
    echo "::error::写库成功了，但用新密码登录失败（HTTP $CODE）：$(jq -c '{error, message}' "$T/login.json" 2>/dev/null || head -c 200 "$T/login.json")"
    exit 1
  fi
fi
