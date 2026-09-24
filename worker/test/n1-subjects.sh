#!/usr/bin/env bash
# N1 学科骨架冒烟测试：subjects 表、学科列表、学科作用域路由、后台学科管理。
# 用临时的本地 D1 跑，跑完自动清理。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8799          # 8791-8798 已被 m2-m6 与 ui-smoke 占用，见 CLAUDE.md 的端口表
BASE="http://localhost:$PORT/api"
PASS=0; FAIL=0

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}

sql() { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one() { sql "$1" | jq -r '.[0].results[0] | to_entries[0].value // empty'; }

cleanup() {
  # wrangler dev 派生的 workerd 子进程只杀 wrangler 本身杀不掉，会继续占端口。
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  rm -rf "$ROOT_DIR/.wrangler"
  rm -f "$ROOT_DIR/.dev.vars"
}
trap cleanup EXIT

# wrangler.toml 的 [assets] 指向 ./public，那是 vite 的产物目录、被 gitignore。
# 不存在时 wrangler dev 起不来，而报错在 dev 日志里，外面只看到"服务 150 秒没起来"，
# 会往网络和端口上找半天。这里提前拦一道，把该跑的命令直接说出来。
if [ ! -d public ]; then
  echo "worker/public 不存在（vite 的构建产物，未提交进仓库）。"
  echo "先跑：npm run build --prefix web"
  exit 1
fi

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-n1
SETUP_TOKEN=test-setup-n1
ENCRYPTION_KEY=test-encryption-key-n1
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 \
    || { echo "执行 $m 失败"; exit 1; }
done
# 导一套英语卷：english 学科要有题（ready=true），biochem 要没题（ready=false）。
# 两个学科的 ready 不同，才测得出"学科之间数据是隔开的"。
npx wrangler d1 execute "$D1_NAME" --local --file=seed/english-000-knowledge-points.sql >/dev/null 2>&1 \
  || { echo "导入考点失败"; exit 1; }
F=$(ls seed/*13000-2024-10.sql 2>/dev/null | head -1)
[ -n "$F" ] || { echo "找不到种子文件，请先跑 node scripts/build-seed-sql.mjs"; exit 1; }
npx wrangler d1 execute "$D1_NAME" --local --file="$F" >/dev/null 2>&1 || { echo "导入 $F 失败"; exit 1; }
npx wrangler d1 execute "$D1_NAME" --local --file=sql/publish-all.sql >/dev/null 2>&1 || true

echo "== 启动服务 =="
DEV_LOG=/tmp/n1-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 &
SERVER_PGID=$!
# wrangler dev 在受限网络下启动要 100 秒以上（它要连几个被拒的 cloudflare.com
# 地址、重试到超时）。等不够久就会拿一个没起来的服务跑完整轮，出一堆看不懂的失败。
ready=0
for i in $(seq 1 150); do
  if curl -sf -m 2 "$BASE/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "服务 150 秒内没起来，dev 日志尾部："; tail -30 "$DEV_LOG"; exit 1
fi
echo "  服务已就绪"

echo
echo "== 迁移把学科建起来了吗 =="
check "subjects 表存在且有两个初始学科" "$(one "SELECT COUNT(*) FROM subjects;")" "2"
check "english 学科的内容组织维度是试卷" \
  "$(one "SELECT content_group_kind FROM subjects WHERE code='english';")" "EXAM_PAPER"
check "biochem 学科的内容组织维度是章节" \
  "$(one "SELECT content_group_kind FROM subjects WHERE code='biochem';")" "TEXTBOOK_CHAPTER"
# 课程必须挂到学科上，否则 /api/me/subjects 的 join 全部落空、进度永远是 0
check "课程 13000 已挂到 english 学科下" \
  "$(one "SELECT s.code FROM courses co JOIN subjects s ON s.subject_id=co.subject_id WHERE co.course_code='13000';")" \
  "english"
check "没有游离的课程（subject_id 为空）" \
  "$(one "SELECT COUNT(*) FROM courses WHERE subject_id IS NULL;")" "0"

echo
echo "== 账号准备 =="
curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-n1' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"admin12345"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin12345"}' | jq -r '.token')
[ "$ADMIN" != "null" ] && [ -n "$ADMIN" ] || { echo "管理员登录失败"; exit 1; }
curl -s -o /dev/null -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"username":"S001","password":"student12345","subjects":["english","biochem"]}'
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
  -d '{"username":"S001","password":"student12345"}' | jq -r '.token')
[ "$STU" != "null" ] && [ -n "$STU" ] || { echo "学员登录失败"; exit 1; }

echo
echo "== 学科选择页的数据源 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/me/subjects")
check "未登录拿不到学科列表" "$CODE" "401"

curl -s -o /tmp/n1-mysubs.json "$BASE/me/subjects" -H "Authorization: Bearer $STU"
# 期望值从库里现算，不写死 2——将来初始学科增减时这条不该跟着红
# N2 之后学员只看到"已授权 ∩ 启用"的学科，所以期望值要按这个口径算，
# 不能再用"所有启用中的学科"——那在没全开通时会误报。
WANT_SUBS=$(one "SELECT COUNT(*) FROM subjects s JOIN user_subject_grants g ON g.subject_id=s.subject_id
                  WHERE s.status='启用' AND g.user_id=(SELECT id FROM users WHERE username='S001')
                    AND g.status='ACTIVE';")
check "学员看到已授权且启用的学科" "$(jq -r '.subjects | length' /tmp/n1-mysubs.json)" "$WANT_SUBS"
check "学科按 sort_order 排序，english 在前" \
  "$(jq -r '.subjects[0].code' /tmp/n1-mysubs.json)" "english"
# ready 区分"学科建了"和"学科能用了"。两个学科的 ready 不同，说明隔离是真的。
check "english 有已发布题目，可进入" "$(jq -r '.subjects[] | select(.code=="english") | .ready' /tmp/n1-mysubs.json)" "true"
check "biochem 还没题，标为未开放" "$(jq -r '.subjects[] | select(.code=="biochem") | .ready' /tmp/n1-mysubs.json)" "false"
WANT_Q=$(one "SELECT COUNT(*) FROM questions q JOIN courses co ON co.course_code=q.course_code JOIN subjects s ON s.subject_id=co.subject_id WHERE s.code='english' AND q.status='已发布';")
check "english 的可抽题数与库里一致" \
  "$(jq -r '.subjects[] | select(.code=="english") | .publishedQuestions' /tmp/n1-mysubs.json)" "$WANT_Q"
echo "     （english 可抽题 $WANT_Q 道）"
check "新学员在 english 下还没考过" \
  "$(jq -r '.subjects[] | select(.code=="english") | .examCount' /tmp/n1-mysubs.json)" "0"

echo
echo "== 学科作用域路由 =="
CODE=$(curl -s -o /tmp/n1-sub.json -w '%{http_code}' "$BASE/s/english" -H "Authorization: Bearer $STU")
check "进入 english 学科" "$CODE" "200"
check "返回学科名" "$(jq -r '.subject.name' /tmp/n1-sub.json)" "英语"
CODE=$(curl -s -o /tmp/n1-404.json -w '%{http_code}' "$BASE/s/nosuchsubject" -H "Authorization: Bearer $STU")
check "不存在的学科返回 404" "$CODE" "404"
check "404 的错误码是 subject_not_found" "$(jq -r '.error' /tmp/n1-404.json)" "subject_not_found"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/s/english")
check "学科作用域接口要登录" "$CODE" "401"

# 学科隔离：english 的课程不能出现在 biochem 名下
curl -s -o /tmp/n1-enc.json "$BASE/s/english/courses" -H "Authorization: Bearer $STU"
curl -s -o /tmp/n1-bic.json "$BASE/s/biochem/courses" -H "Authorization: Bearer $STU"
WANT_EN=$(one "SELECT COUNT(*) FROM courses co JOIN subjects s ON s.subject_id=co.subject_id WHERE s.code='english';")
check "english 的课程数与库里一致" "$(jq -r '.courses | length' /tmp/n1-enc.json)" "$WANT_EN"
# 原来这条断的是"biochem 名下一门课都没有"。那时生化还没有课程行，
# 所以它测的是"生化是空的"，不是"两科没串"——N6 给生化建了课程行，它当场变红。
# 改成断两边的课程码没有交集，并且加一条"生化确实有课"，
# 否则交集为空这件事又会因为一边是空集而自动成立。
WANT_BI=$(one "SELECT COUNT(*) FROM courses co JOIN subjects s ON s.subject_id=co.subject_id WHERE s.code='biochem';")
check "biochem 的课程数与库里一致" "$(jq -r '.courses | length' /tmp/n1-bic.json)" "$WANT_BI"
check "生化确实有课（否则下一条是空断言）" "$([ "${WANT_BI:-0}" -ge 1 ] && echo 有 || echo 无)" "有"
check "两科的课程码没有交集" \
  "$(jq -r --argjson en "$(jq -c '[.courses[].course_code]' /tmp/n1-enc.json)" \
     '[.courses[].course_code] | map(select(. as $c | $en | index($c))) | length' /tmp/n1-bic.json)" "0"
check "english 课程列表里确实是 13000" \
  "$(jq -r '[.courses[].course_code] | index("13000") != null' /tmp/n1-enc.json)" "true"

echo
echo "== 后台学科管理 =="
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/admin/subjects" -H "Authorization: Bearer $STU")
check "学员访问后台学科接口被拒" "$CODE" "403"

CODE=$(curl -s -o /tmp/n1-new.json -w '%{http_code}' -X POST "$BASE/admin/subjects" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"code":"history","name":"中国近现代史","sortOrder":3}')
check "管理员可新建学科" "$CODE" "201"
NEW_ID=$(jq -r '.subject.subjectId' /tmp/n1-new.json)
check "新学科真的落库了" "$(one "SELECT name FROM subjects WHERE code='history';")" "中国近现代史"

CODE=$(curl -s -o /tmp/n1-bad.json -w '%{http_code}' -X POST "$BASE/admin/subjects" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"code":"History_1","name":"大写下划线都不合法"}')
check "非法学科码被拒" "$CODE" "400"
check "非法学科码的错误码" "$(jq -r '.error' /tmp/n1-bad.json)" "invalid_subject_code"

CODE=$(curl -s -o /tmp/n1-dup.json -w '%{http_code}' -X POST "$BASE/admin/subjects" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"code":"english","name":"重名"}')
check "学科码重复返回 409" "$CODE" "409"

# 改不动的字段必须报错，不能默默忽略——默默忽略的话调用方以为改成功了
CODE=$(curl -s -o /tmp/n1-imm.json -w '%{http_code}' -X PATCH "$BASE/admin/subjects/$NEW_ID" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"code":"newcode"}')
check "改学科码被拒" "$CODE" "400"
check "改学科码的错误码" "$(jq -r '.error' /tmp/n1-imm.json)" "immutable_field"
check "学科码确实没被改动" "$(one "SELECT code FROM subjects WHERE subject_id=$NEW_ID;")" "history"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X PATCH "$BASE/admin/subjects/$NEW_ID" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"name":"中国近现代史纲要"}')
check "可以改学科名" "$CODE" "200"
check "改名已落库" "$(one "SELECT name FROM subjects WHERE subject_id=$NEW_ID;")" "中国近现代史纲要"

CODE=$(curl -s -o /dev/null -w '%{http_code}' -X DELETE "$BASE/admin/subjects/$NEW_ID" \
  -H "Authorization: Bearer $ADMIN")
check "学科不支持删除" "$CODE" "405"

echo
echo "== 停用学科 =="
# 先给 S001 开通这个新学科，再停用它。不先开通的话，"停用后不出现在列表里"
# 这条断言恒真——它本来就因为没授权而不出现，测不出停用有没有生效。
curl -s -o /dev/null -X PUT "$BASE/admin/users/$(one "SELECT id FROM users WHERE username='S001';")/subjects" \
  -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' \
  -d '{"subjects":[{"code":"english"},{"code":"biochem"},{"code":"history"}]}'
sget_before=$(curl -s "$BASE/me/subjects" -H "Authorization: Bearer $STU" | jq -r '[.subjects[].code] | index("history") != null')
check "停用前：已授权的新学科出现在列表里（否则下面那条恒真）" "$sget_before" "true"
curl -s -o /dev/null -X PATCH "$BASE/admin/subjects/$NEW_ID" -H "Authorization: Bearer $ADMIN" \
  -H 'Content-Type: application/json' -d '{"status":"停用"}'
CODE=$(curl -s -o /tmp/n1-susp.json -w '%{http_code}' "$BASE/s/history" -H "Authorization: Bearer $STU")
check "停用的学科进不去" "$CODE" "403"
# 停用和没权限要分开：不然管理员停用了学科、学员却收到"请联系管理员开通"，两边都不知道发生了什么
check "停用的错误码与「没权限」分得开" "$(jq -r '.error' /tmp/n1-susp.json)" "subject_suspended"
curl -s -o /tmp/n1-after.json "$BASE/me/subjects" -H "Authorization: Bearer $STU"
check "停用的学科不出现在学员的学科列表里" \
  "$(jq -r '[.subjects[].code] | index("history") // "absent"' /tmp/n1-after.json)" "absent"
check "停用只是改状态，数据还在" "$(one "SELECT COUNT(*) FROM subjects WHERE code='history';")" "1"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
