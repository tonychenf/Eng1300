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
#   管理员       撤回一章、停用一道题、改两档 AI 配置、撤掉一个学员的一个学科；仓库里英语、生化各新加了一个题库文件
#   第 2 次部署  迁移重跑 + 导入新文件，线上验证要全过（加英语文件以前会让「20 套 / 1020 道」红，M16），
#                管理员改的东西要都还在
#
# 然后反过来证明线上验证会红：写入哨兵（最后登录时间没写进去）、发布状态（部署把一章弄丢了）、
# 已发布章节带着存疑、没有部署前的记录；最后是 CR-H4 的规矩——导入过的题库文件被改了：
#   第 3 次部署  拒绝导入、库里不动，线上验证报红并点名
#   第 4 次部署  文件改回去，照常全过
# 最后：库里的章节和题库文件对不上（少了题、少了章），线上验证要红并点名（M16）。
# 题库文件用的是这一套自己的副本（SUBJECTS_ROOT），改它碰不到仓库里的 data/。
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
  PUBLISHED_BEFORE_FILE="$WORK/published-before.txt" SEED_REFUSED_FILE="$WORK/seed-refused.txt" \
  SUBJECTS_ROOT="$WORK/subjects" SEED_OUT="$WORK/seed"
# 题库文件的副本：后面要往里加新文件、改已导入的文件
cp -r "$REPO_DIR/data/subjects" "$WORK/subjects"

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
verify_fails() { grep '^  FAIL' "$WORK/verify-$1.log" | sed 's/^  FAIL //' | awk 'NR > 1 { printf "；" } { printf "%s", $0 }'; }
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
npx wrangler d1 execute "$D1_NAME" --local --file=test/fixtures/publish-all.sql >/dev/null 2>&1 \
  || { echo "publish-all.sql 失败"; exit 1; }
EN_PUB=$(one "SELECT COUNT(*) FROM exams WHERE course_code = '13000' AND status = '已发布';")
check "（前提）英语有已发布的章节" "$(( ${EN_PUB:-0} > 0 ))" "1"

echo
echo "== 第 1 次部署：平常的一次 =="
deploy 1 || exit 1
show_verify 1
check "线上验证全过" "$VERIFY_RC/$(verify_fails 1)" "0/"

echo
echo "== 管理员在后台改了几样东西；仓库里新加了一个题库文件 =="
# 撤回哪一章、停用哪道题都从库里现挑：撤回的得是已发布的英语章节，停用的得是另一章里已发布的题
mapfile -t PICK < <(sql "SELECT exam_id FROM exams WHERE course_code = '13000' AND status = '已发布'
                          ORDER BY exam_id DESC LIMIT 2;" | jq -r '.[0].results[].exam_id')
W=${PICK[0]:-}; R=${PICK[1]:-}
RQ=$(one "SELECT question_id FROM questions WHERE exam_id = '$R' AND status = '已发布' ORDER BY ord LIMIT 1;")
echo "     撤回 $W；停用 $R 里的 $RQ"
check "（前提）挑到了两章已发布的英语和一道已发布的题" \
  "$([ -n "$W" ] && [ -n "$R" ] && [ -n "$RQ" ] && echo yes)" "yes"
CODE=$(api -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/bank/exams/$W/unpublish")
check "（前提）撤回 $W" "$CODE/$(exam_status "$W")" "200/待校对"
CODE=$(api -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/bank/questions/$RQ/retire")
check "（前提）停用 $RQ：退回草稿、记下停用时间" \
  "$CODE/$(one "SELECT status || '/' || (retired_at IS NOT NULL) FROM questions WHERE question_id = '$RQ';")" "200/草稿/1"
api -o /dev/null -X PUT "$BASE/admin/ai/settings/PARSING" -H 'Content-Type: application/json' -d '{"model":"admin-ocr"}'
api -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" -H 'Content-Type: application/json' -d '{"model":"admin-tutor"}'
check "（前提）后台改了图片解析、教学两档的模型" "$(ai_model PARSING)/$(ai_model TUTORING)" "admin-ocr/admin-tutor"
T002=$(one "SELECT id FROM users WHERE username = 'T002';")
api -o /dev/null -X PUT "$BASE/admin/users/$T002/subjects" -H 'Content-Type: application/json' \
  -d '{"subjects":[{"code":"english"}]}'
check "（前提）撤掉了 T002 的生化" "$(grants_of T002)" "english"
# 内容要改的正确做法：用新的内容组编号加一个新文件（题目、大题编号跟着新编号走）。
# 英语、生化各加一个：英语用 examId/title，生化用 groupId/label。英语那个专门照 M16——
# 线上验证以前断"英语 20 套 / 1020 道"，按正规做法加一个英语文件它就红。
copy_group() {
  python3 - "$1" "$2" <<'PY'
import json, sys, os
src, gid = sys.argv[1], sys.argv[2]
d = json.load(open(src, encoding='utf-8'))
key = 'examId' if 'examId' in d else 'groupId'
name = 'title' if key == 'examId' else 'label'
old = d[key]; d[key] = gid; d[name] += '（订正版）'
for s in d['sections']:
    s['sectionId'] = s['sectionId'].replace(old, gid, 1)
    for q in s['questions']:
        q['questionId'] = q['questionId'].replace(old, gid, 1)
json.dump(d, open(os.path.join(os.path.dirname(src), gid + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
}
copy_group "$WORK/subjects/biochem/groups/biochem-ch01.json" biochem-ch01-v2
EN_SRC=$(ls "$WORK/subjects/english/groups/"*.json | head -1)
EN_V2="$(basename "$EN_SRC" .json)-v2"
copy_group "$EN_SRC" "$EN_V2"
echo "     新加 biochem-ch01-v2、$EN_V2（照 $(basename "$EN_SRC") 改编号）"

echo
echo "== 第 2 次部署：迁移重跑，导入新文件 =="
migrate || exit 1
deploy 2 || exit 1
show_verify 2
check "导题库只导了新加的两个文件" \
  "$(grep '^── 导入 ' "$WORK/deploy-2.log" | sed -E 's/^── 导入 [a-z]+-[0-9]{3}-//' | LC_ALL=C sort | paste -sd, -)" \
  "$EN_V2.sql,biochem-ch01-v2.sql"
check "新章节进了库、待校对，部署不替人发布" "$(exam_status biochem-ch01-v2)/$(exam_status "$EN_V2")" "待校对/待校对"
check "线上验证全过（管理员撤回过一章、停用过一道题、加了一个英语新文件）" "$VERIFY_RC/$(verify_fails 2)" "0/"
check "撤回的 $W 没被部署放回去（H2）" "$(exam_status "$W")" "待校对"
check "$R 照旧是已发布（导入过的章节不再重导）" "$(exam_status "$R")" "已发布"
check "停用的 $RQ 还是停用、还是草稿（部署不会让它复活）" \
  "$(one "SELECT status || '/' || (retired_at IS NOT NULL) FROM questions WHERE question_id = '$RQ';")" "草稿/1"
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
# 把一章冲回了草稿（以前种子整章重导就会这样）
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
# 有哪条路绕过了发布那道门（存疑清零才能发布），已发布的章节就会带着存疑——直接改库模拟
exec_sql "INSERT INTO exam_parsing_notes (exam_id, note) VALUES ('$R', 'deploy-local：绕过发布门的存疑');"
bash "$CI/verify-deployment.sh" > "$WORK/verify-notes.log" 2>&1; RC=$?
check "已发布的 $R 留着一条没处理的存疑：线上验证失败" \
  "$RC/$(grep -c '^  FAIL 已发布的章节没有未处理的解析存疑' "$WORK/verify-notes.log")" "1/1"
exec_sql "DELETE FROM exam_parsing_notes WHERE note = 'deploy-local：绕过发布门的存疑';"

echo
echo "== 线上验证能红：没有部署前的记录 =="
rm -f "$PUBLISHED_BEFORE_FILE"
bash "$CI/verify-deployment.sh" > "$WORK/verify-nofile.log" 2>&1; RC=$?
check "没有部署前的记录：线上验证失败，不当成没变" \
  "$RC/$(grep -c '^  FAIL 部署前的发布状态没有记录' "$WORK/verify-nofile.log")" "1/1"

echo
echo "== 第 3 次部署：导入过的题库文件被改了（CR-H4） =="
RF="$WORK/subjects/english/groups/$R.json"
cp "$RF" "$WORK/r.bak"
python3 - "$RF" <<'PY'
import json, sys
p = sys.argv[1]; d = json.load(open(p, encoding='utf-8'))
q = d['sections'][0]['questions'][0]; q['stem'] = (q.get('stem') or '') + '（文件后来改过）'
json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
PY
STEM_BEFORE=$(one "SELECT COUNT(*) FROM questions WHERE exam_id = '$R' AND stem LIKE '%文件后来改过%';")
deploy 3 || exit 1
check "导题库没有导入它" "$(grep -c '^── 导入 ' "$WORK/deploy-3.log")" "0"
check "库里这一章没动" "$STEM_BEFORE/$(one "SELECT COUNT(*) FROM questions WHERE exam_id = '$R' AND stem LIKE '%文件后来改过%';")/$(exam_status "$R")" "0/0/已发布"
check "线上验证失败" "$VERIFY_RC" "1"
check "  红的就是这一条，并且点名是哪个文件" \
  "$(verify_fails 3 | grep -c "导题库拒绝了 1 个题库文件")/$(grep -c "$R" "$SEED_REFUSED_FILE")" "1/1"

echo
echo "== 第 4 次部署：文件改回去 =="
cp "$WORK/r.bak" "$RF"
deploy 4 || exit 1
check "线上验证全过" "$VERIFY_RC/$(verify_fails 4)" "0/"

echo
echo "== 线上验证能红：库里的章节和题库文件对不上（CR-M16） =="
# 期望从文件现算，所以加文件不会让它红（上面第 2 次部署已证明）；该红的是导入丢了东西。
# 删新章节里的一道题（它没人做过，子表只有这三张）
DQ=$(one "SELECT question_id FROM questions WHERE exam_id = 'biochem-ch01-v2' ORDER BY ord DESC LIMIT 1;")
FILE_N=$(jq '[.sections[].questions | length] | add' "$WORK/subjects/biochem/groups/biochem-ch01-v2.json")
exec_sql "DELETE FROM question_items WHERE question_id = '$DQ'; DELETE FROM question_knowledge_points WHERE question_id = '$DQ';
          DELETE FROM question_assets WHERE question_id = '$DQ'; DELETE FROM questions WHERE question_id = '$DQ';"
check "（前提）库里的 biochem-ch01-v2 比文件少一道" \
  "$(one "SELECT COUNT(*) FROM questions WHERE exam_id = 'biochem-ch01-v2';")" "$((FILE_N - 1))"
# 仓库里多一个文件、库里却没有这一章（导题库那一步没导它）
copy_group "$EN_SRC" "$(basename "$EN_SRC" .json)-v3"
bash "$CI/verify-deployment.sh" > "$WORK/verify-mismatch.log" 2>&1; RC=$?
check "线上验证失败" "$RC" "1"
check "  点名少题的章节和两边的题数" \
  "$(grep '^  FAIL 题库文件和库里对不上' "$WORK/verify-mismatch.log" | grep -c "biochem-ch01-v2（文件 $FILE_N 道，库里 $((FILE_N - 1)) 道）")" "1"
check "  点名库里没有的章节" \
  "$(grep '^  FAIL 题库文件和库里对不上' "$WORK/verify-mismatch.log" | grep -c "$(basename "$EN_SRC" .json)-v3（文件 [0-9]* 道，库里没有这一章）")" "1"
check "  红的只有这一条" "$(grep -c '^  FAIL' "$WORK/verify-mismatch.log")" "1"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
