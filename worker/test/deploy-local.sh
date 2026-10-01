#!/usr/bin/env bash
# 部署彩排（CR-M8）：部署流水线后半段的那些脚本，在本地新库上按部署顺序真跑。
#
# 为什么要有这一套：这些脚本以前内联在 deploy-worker.yml 里，只有真部署时才跑得到。几个问题
# 都是这样藏了很久的——部署每次把后台改过的 AI 配置冲回去（M10）、新库上建出来的学员一个学科
# 都没开通（M13）、线上验证把"英语 20 套全部已发布"当不变量，管理员一撤回就红（M14）。
# 它们都要"连着部署两次、中间有人在后台改过东西"才会出现，所以这里就这么跑：
#
#   第 0 次部署  全新的库（第一次上线）
#   管理员       核完英语、发布（用测试造数据的 publish-all.sql 代替逐章点发布）
#   第 1 次部署  平常的一次部署，线上验证要全过
#   管理员       撤回一章、改两档 AI 配置、撤掉一个学员的一个学科；另有两章的种子变了
#   第 2 次部署  迁移重跑 + 那两章重导，线上验证要全过，管理员改的东西要都还在
#
# 然后反过来证明线上验证会红：写入哨兵（最后登录时间没写进去）、发布状态（部署把一章弄丢了）。
#
# 覆盖不到：调 Cloudflare 接口的几步（账号、子域名、建库、Worker 密钥）和 wrangler deploy
# 本身——本地连不上 api.cloudflare.com。「等服务就绪」那步按 workers.dev 拼地址，也不跑。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ROOT_DIR/.." && pwd)"
CI="$REPO_DIR/scripts/ci"
cd "$ROOT_DIR"
D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }
export D1_NAME
export WRANGLER_SEND_METRICS=false CLOUDFLARE_CF_FETCH_ENABLED=false

PORT=8775          # 端口表见 CLAUDE.md
URL="http://127.0.0.1:$PORT"
BASE="$URL/api"
DEV_LOG=/tmp/deploy-local-dev.log
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
source "$ROOT_DIR/test/lib/d1.sh"   # sql / one / exec_sql（读库失败会在 stderr 报出来）

WORK=$(mktemp -d)
cleanup() {
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; wait "$SERVER_PGID" 2>/dev/null; fi
  rm -rf "$ROOT_DIR/.wrangler" "$WORK"; rm -f "$ROOT_DIR/.dev.vars"
}
trap cleanup EXIT

[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }

# 流水线里各步之间靠 GITHUB_ENV 传值（令牌、登录时刻……），这里用同一个机制
export GITHUB_ENV="$WORK/github_env"; : > "$GITHUB_ENV"
load_env() { local k v; while IFS='=' read -r k v; do [ -n "$k" ] && export "$k=$v"; done < "$GITHUB_ENV"; }
export WORKER_URL="$URL" SETUP_TOKEN_VALUE=test-setup-deploy ADMIN_PASSWORD=adminpass123 \
  STUDENT_PASSWORD=student123 AI_API_KEY=stub-key AI_BASE_URL="http://127.0.0.1:9/v1" \
  PUBLISHED_BEFORE_FILE="$WORK/published-before.txt"

migrate() {
  local m
  for m in migrations/*.sql; do
    npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "迁移 $m 失败"; return 1; }
  done
}

# 一次部署：顺序与 deploy-worker.yml 的 deploy job 一致（迁移由调用方决定跑不跑）。
# 每步的输出进 $WORK/deploy-<n>.log，失败的那步在屏幕上点名；线上验证的输出单独留着要断言。
deploy() {
  local n=$1 log="$WORK/deploy-$1.log"
  : > "$log"
  step() {
    local name=$1; shift
    echo "── $name" >> "$log"
    "$@" >> "$log" 2>&1 && return 0
    echo "  !! 第 $n 次部署「$name」失败："; tail -15 "$log" | sed 's/^/     /'; return 1
  }
  step "记下部署前的发布状态" bash "$CI/record-published.sh" --local || return 1
  step "导题库" env SEED_LOCAL=1 bash "$CI/seed-if-changed.sh" || return 1
  step "放行" npx wrangler d1 execute "$D1_NAME" --local --file=sql/republish-reseeded.sql || return 1
  step "建超级管理员" bash "$CI/bootstrap-admin.sh" || return 1
  step "清 admin 锁定" npx wrangler d1 execute "$D1_NAME" --local --file=sql/clear-admin-lockout.sql || return 1
  step "取管理员令牌" bash "$CI/get-admin-token.sh" || return 1
  load_env
  step "建学员" bash "$CI/bootstrap-students.sh" || return 1
  step "写 AI 配置" bash "$CI/configure-ai.sh" || return 1
  bash "$CI/verify-deployment.sh" > "$WORK/verify-$n.log" 2>&1
  VERIFY_RC=$?
  return 0
}
verify_fails() { grep '^  FAIL' "$WORK/verify-$1.log" | sed 's/^  FAIL //' | paste -sd'；' -; }
show_verify() { grep -E '^  (OK|FAIL)' "$WORK/verify-$1.log" | grep -E 'FAIL|写入|发布状态|授权' | sed 's/^/     /'; }
api() { curl -s -m 20 "$@" -H "Authorization: Bearer $ADMIN_TOKEN"; }
ai_model() { api "$BASE/admin/ai/settings" | jq -r --arg p "$1" '.settings[$p].model // "无"'; }
grants_of() {
  one "SELECT COALESCE(group_concat(code, ','), '无') FROM (SELECT s.code FROM user_subject_grants g
         JOIN users u ON u.id = g.user_id JOIN subjects s ON s.subject_id = g.subject_id
        WHERE u.username = '$1' AND g.status = 'ACTIVE' ORDER BY s.code);"
}
exam_status() { one "SELECT status FROM exams WHERE exam_id = '$1';"; }

echo "== 准备：全新的本地库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-deploy
SETUP_TOKEN=test-setup-deploy
ENCRYPTION_KEY=test-encryption-key-deploy
VARS
migrate || exit 1

echo "== 启动服务 =="
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }

echo
echo "== 第 0 次部署：全新的库 =="
deploy 0 || exit 1
echo "     （英语还没人发布，下面「可抽题」两条第一次上线本来就过不了，不算这一套的失败）"; show_verify 0
# 第一次上线时英语还没人发布，所以线上验证里"英语有可抽题"这类本来就过不了——这一次不要求全过，
# 只断部署自己该做到的事
check "新库上建出来的学员有学科授权（M13）" "$(grants_of T001)" "biochem,english"
check "三档 AI 配置都补上了" \
  "$(api "$BASE/admin/ai/settings" | jq -r '[.settings[] | select(. != null and .hasKey)] | length')" "3"
check "写入哨兵在第一次部署就成立" "$(grep -c '^  OK   写入已恢复' "$WORK/verify-0.log")" "1"
check "发布状态比对在第一次部署就成立（部署前后都是 0 章）" \
  "$(grep -c '^  OK   部署没有改变任何章节的发布状态' "$WORK/verify-0.log")" "1"

echo
echo "== 管理员核完英语、发布 =="
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1 \
  || { echo "publish-all.sql 失败"; exit 1; }
EN_PUB=$(one "SELECT COUNT(*) FROM exams WHERE course_code = '13000' AND status = '已发布';")
check "（前提）英语有已发布的章节" "$(( ${EN_PUB:-0} > 0 ))" "1"

echo
echo "== 第 1 次部署：平常的一次 =="
deploy 1 || exit 1
show_verify 1
check "线上验证全过" "$VERIFY_RC/$(verify_fails 1)" "0/"

echo
echo "== 管理员在后台改了几样东西；另有两章的种子文件变了 =="
# 撤回哪一章、重导哪一章都从库里现挑：都得是已发布的英语章节，种子文件得找得到
mapfile -t PICK < <(sql "SELECT exam_id FROM exams WHERE course_code = '13000' AND status = '已发布'
                          ORDER BY exam_id DESC LIMIT 2;" | jq -r '.[0].results[].exam_id')
W=${PICK[0]:-}; R=${PICK[1]:-}
seed_file() { grep -l "INSERT INTO exams (exam_id[^)]*) VALUES ('$1'" seed/english-*.sql 2>/dev/null | head -1; }
WF=$(seed_file "$W"); RF=$(seed_file "$R")
echo "     撤回 $W（$WF），另一章 $R（$RF）只是种子变了"
check "（前提）挑到了两章已发布的英语，种子文件都在" \
  "$([ -n "$W" ] && [ -n "$R" ] && [ -f "$WF" ] && [ -f "$RF" ] && echo yes)" "yes"
CODE=$(api -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/bank/exams/$W/unpublish")
check "（前提）撤回 $W" "$CODE/$(exam_status "$W")" "200/待校对"
api -o /dev/null -X PUT "$BASE/admin/ai/settings/PARSING" -H 'Content-Type: application/json' -d '{"model":"admin-ocr"}'
api -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" -H 'Content-Type: application/json' -d '{"model":"admin-tutor"}'
check "（前提）后台改了图片解析、教学两档的模型" "$(ai_model PARSING)/$(ai_model TUTORING)" "admin-ocr/admin-tutor"
T002=$(one "SELECT id FROM users WHERE username = 'T002';")
api -o /dev/null -X PUT "$BASE/admin/users/$T002/subjects" -H 'Content-Type: application/json' \
  -d '{"subjects":[{"code":"english"}]}'
check "（前提）撤掉了 T002 的生化" "$(grants_of T002)" "english"
# 种子文件变了 = 库里记的指纹对不上；删掉指纹，导题库那一步就会重导这两章（先删后插，冲回草稿）
exec_sql "DELETE FROM seed_state WHERE name IN ('$(basename "$WF")', '$(basename "$RF")');"

echo
echo "== 第 2 次部署：迁移重跑，那两章重导 =="
migrate || exit 1
deploy 2 || exit 1
show_verify 2
check "导题库确实重导了那两章" "$(grep -c '^── 导入 ' "$WORK/deploy-2.log")" "2"
check "线上验证全过（管理员撤回过一章）" "$VERIFY_RC/$(verify_fails 2)" "0/"
check "撤回的 $W 没被部署放回去（H2）" "$(exam_status "$W")" "待校对"
check "只是重导的 $R 放回了已发布（放行）" "$(exam_status "$R")" "已发布"
check "后台改过的图片解析、教学没被冲掉（M10）" "$(ai_model PARSING)/$(ai_model TUTORING)" "admin-ocr/admin-tutor"
check "  并且说明了三档都是配过就不动" "$(grep -c '已经配过，不动' "$WORK/deploy-2.log")" "3"
check "撤掉的 T002 生化没被补回来" "$(grants_of T002)" "english"
check "其他学员的授权没动" "$(grants_of T001)" "biochem,english"

echo
echo "== 线上验证能红：写入哨兵 =="
# 额度用尽时登录照样放行，只是"最后登录时间"写不进去——这里直接把它改回一个旧值来模拟
exec_sql "UPDATE users SET last_login_at = '2000-01-01 00:00:00' WHERE username = 'admin';"
bash "$CI/verify-deployment.sh" > "$WORK/verify-sentinel.log" 2>&1; RC=$?
check "最后登录时间没写进去：线上验证失败" "$RC" "1"
check "  并且点名是写入没恢复" "$(grep -c '^  FAIL 写入未恢复' "$WORK/verify-sentinel.log")" "1"
check "  其余各条照常通过（只有这一条红）" "$(grep -c '^  FAIL' "$WORK/verify-sentinel.log")" "1"

echo
echo "== 线上验证能红：部署改了发布状态 =="
# 部署前记的是第 2 次部署开头的状态（$R 当时是已发布）。直接改库模拟部署出的错：
# "重导把它冲回草稿、放行没放回来"
exec_sql "UPDATE exams SET status = '待校对' WHERE exam_id = '$R';"
exec_sql "UPDATE users SET last_login_at = datetime('now') WHERE username = 'admin';"
bash "$CI/verify-deployment.sh" > "$WORK/verify-lost.log" 2>&1; RC=$?
check "部署弄丢了一章已发布：线上验证失败" "$RC" "1"
check "  并且点名是哪一章" "$(grep '^  FAIL 部署改变了章节的发布状态' "$WORK/verify-lost.log" | grep -c "少了 $R")" "1"
# 反方向：部署多放出来一章（H2 那种"撤回的被放回去"）
exec_sql "UPDATE exams SET status = '已发布' WHERE exam_id IN ('$R', '$W');"
check "（前提）$W 被放回了已发布" "$(exam_status "$W")" "已发布"
bash "$CI/verify-deployment.sh" > "$WORK/verify-extra.log" 2>&1; RC=$?
check "部署多放出来一章：线上验证失败" "$RC" "1"
check "  并且点名是哪一章" "$(grep '^  FAIL 部署改变了章节的发布状态' "$WORK/verify-extra.log" | grep -c "多了 $W")" "1"
exec_sql "UPDATE exams SET status = '待校对' WHERE exam_id = '$W';"

echo
echo "== 线上验证能红：已发布的章节带着没处理的存疑 =="
# 重导把存疑插回来、放行却没处理掉——发布那道门本来不让这种章节上线
exec_sql "INSERT INTO exam_parsing_notes (exam_id, note) VALUES ('$R', 'deploy-local：放行漏处理的存疑');"
bash "$CI/verify-deployment.sh" > "$WORK/verify-notes.log" 2>&1; RC=$?
check "已发布的 $R 留着一条没处理的存疑：线上验证失败" \
  "$RC/$(grep -c '^  FAIL 已发布的章节没有未处理的解析存疑' "$WORK/verify-notes.log")" "1/1"
exec_sql "DELETE FROM exam_parsing_notes WHERE note = 'deploy-local：放行漏处理的存疑';"

echo
echo "== 线上验证能红：没有部署前的记录 =="
rm -f "$PUBLISHED_BEFORE_FILE"
bash "$CI/verify-deployment.sh" > "$WORK/verify-nofile.log" 2>&1; RC=$?
check "没有部署前的记录：线上验证失败，不当成没变" \
  "$RC/$(grep -c '^  FAIL 部署前的发布状态没有记录' "$WORK/verify-nofile.log")" "1/1"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
