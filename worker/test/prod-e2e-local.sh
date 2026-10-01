#!/usr/bin/env bash
# 线上实测的本地彩排（CR-M4）：本地服务 + AI 替身，把流水线里的三个脚本原样跑一遍——
#   get-admin-token.sh → configure-ai.sh（部署写 AI 配置）→ prod-e2e.sh（线上实测）
#
# 为什么要有这一套：prod-e2e.sh 只在手动触发时对线上跑，XLearn 复制过来之后它一次都没跑成过
# （地址空着、探针账号没开学科授权），而没有任何东西会发现。这里证明的是**脚本本身**的
# 流程和断言对不对；真实模型的返回结构与时延，替身证明不了，那一半只能交给线上那一次。
#
# 另外钉住部署里「文字解析只补不改」：第一次补上，管理员在后台改过之后再部署不动它。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$ROOT_DIR/.." && pwd)"
cd "$ROOT_DIR"
D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8777          # 端口表见 CLAUDE.md
STUB_PORT=8893
URL="http://127.0.0.1:$PORT"
BASE="$URL/api"
SAMPLE="$REPO_DIR/scripts/ci/fixtures/prod-e2e-sample.docx"
PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
source "$ROOT_DIR/test/lib/d1.sh"   # sql / one / exec_sql（读库失败会在 stderr 报出来）

cleanup() {
  if [ -n "${SERVER_PGID:-}" ]; then kill -9 -- "-$SERVER_PGID" 2>/dev/null || true; fi
  if [ -n "${STUB_PID:-}" ]; then kill "$STUB_PID" 2>/dev/null || true; fi
  rm -rf "$ROOT_DIR/.wrangler"; rm -f "$ROOT_DIR/.dev.vars" "${ENVF:-}"
}
trap cleanup EXIT

[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }
[ -f "$SAMPLE" ] || { echo "样本 docx 不在：$SAMPLE（node scripts/ci/make-e2e-sample.mjs 生成）"; exit 1; }
ls seed/english-*-13000-*.sql >/dev/null 2>&1 || { echo "没有英语种子。先跑：node scripts/build-seed-sql.mjs"; exit 1; }

echo "== 准备本地数据库 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-pe2e
SETUP_TOKEN=test-setup-pe2e
ENCRYPTION_KEY=test-encryption-key-pe2e
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "执行 $m 失败"; exit 1; }
done
# 实测组的是 13000 的卷，导这门课的几套就够
for f in seed/english-000-knowledge-points.sql seed/english-*-13000-*.sql test/fixtures/publish-all.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$f" >/dev/null 2>&1 || { echo "导入 $f 失败"; exit 1; }
done
# 实测脚本这里要跑三遍，每遍组一份卷，一分钟内就超过每分钟 3 份。限流不是这一套要测的
exec_sql "UPDATE system_settings SET value='1000' WHERE key IN ('limit.exam_per_minute', 'limit.exam_per_day');"

node test/ai-stub.mjs "$STUB_PORT" > /tmp/pe2e-stub.log 2>&1 &
STUB_PID=$!
for i in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$STUB_PORT/last-prompt" >/dev/null 2>&1 && break; sleep 0.3; done

echo "== 启动服务 =="
DEV_LOG=/tmp/pe2e-dev.log
for i in $(seq 1 20); do ss -ltn 2>/dev/null | grep -q ":$PORT " || break; sleep 1; done
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PGID=$!
ready=0
for i in $(seq 1 150); do
  curl -sf -m 2 "$BASE/health" >/dev/null 2>&1 && { ready=1; break; }; sleep 1
done
[ "$ready" -eq 1 ] || { echo "服务 150 秒没起来："; tail -30 "$DEV_LOG"; exit 1; }
curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-pe2e' \
  -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'

echo
echo "== 管理员令牌：流水线用的 get-admin-token.sh =="
ENVF=$(mktemp)
GITHUB_ENV="$ENVF" WORKER_URL="$URL" ADMIN_PASSWORD=adminpass123 \
  bash "$REPO_DIR/scripts/ci/get-admin-token.sh" > /tmp/pe2e-token.log 2>&1
ADMIN_TOKEN=$(grep '^ADMIN_TOKEN=' "$ENVF" | cut -d= -f2-)
check "拿到了管理员令牌" "$([ -n "$ADMIN_TOKEN" ] && echo yes)" "yes"
[ -n "$ADMIN_TOKEN" ] || { cat /tmp/pe2e-token.log; exit 1; }
settings() { curl -s "$BASE/admin/ai/settings" -H "Authorization: Bearer $ADMIN_TOKEN"; }

echo
echo "== 部署写 AI 配置：configure-ai.sh =="
cfg() {
  WORKER_URL="$URL" ADMIN_TOKEN="$ADMIN_TOKEN" AI_API_KEY=stub-key \
    AI_BASE_URL="http://127.0.0.1:$STUB_PORT/v1" bash "$REPO_DIR/scripts/ci/configure-ai.sh" 2>&1
}
check "（前提）一档都还没配" "$(settings | jq -r '[.settings[] | select(. != null)] | length')" "0"
OUT=$(cfg); RC=$?
echo "$OUT" | sed 's/^/     /'
check "第一次部署：脚本成功" "$RC" "0"
check "三档都配上了" "$(settings | jq -r '[.settings[] | select(. != null and .hasKey)] | length')" "3"
check "文字解析补上的是 Qwen/Qwen3-8B" "$(settings | jq -r '.settings.TEXT_PARSING.model')" "Qwen/Qwen3-8B"
# 管理员在后台把文字解析换了个模型，下一次部署不能把它改回去
curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/TEXT_PARSING" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d '{"model":"admin-picked"}'
check "（前提）后台改成了 admin-picked" "$(settings | jq -r '.settings.TEXT_PARSING.model')" "admin-picked"
OUT=$(cfg); RC=$?
check "第二次部署：脚本成功" "$RC" "0"
check "  并且说明了配过就不动" "$(echo "$OUT" | grep -c 'TEXT_PARSING 已经配过，不动')" "1"
check "后台改过的文字解析没被冲掉" "$(settings | jq -r '.settings.TEXT_PARSING.model')" "admin-picked"

e2e() { WORKER_URL="$URL" ADMIN_TOKEN="$ADMIN_TOKEN" bash "$REPO_DIR/scripts/ci/prod-e2e.sh" 2>&1; }
show() { echo "$1" | grep -E "FAIL|小结|耗时|已新建|复用|补开|清掉|没配" | sed 's/^/     /'; }
probe_left() { one "SELECT COUNT(*) FROM exams WHERE exam_id='e2e-probe';"; }

echo
echo "== prod-e2e.sh 第一遍：全新的库，探针账号还不存在 =="
OUT=$(e2e); RC=$?
show "$OUT"
check "第一遍：退出码 0、一条 FAIL 都没有" "$RC/$(echo "$OUT" | grep -c 'FAIL')" "0/0"
check "  上传出题那一段真的跑了（不是被跳过）" "$(echo "$OUT" | grep -c 'OK   4 道全部生成')" "1"
check "  英语那一段也跑到了最后" "$(echo "$OUT" | grep -c 'OK   能力评估接口可用')" "1"
check "  测试章节没有留在库里" "$(probe_left)" "0"
check "  探针账号开通了英语" \
  "$(one "SELECT g.status FROM user_subject_grants g JOIN users u ON u.id = g.user_id
            JOIN subjects s ON s.subject_id = g.subject_id WHERE u.username = 'PROBE01' AND s.code = 'english';")" "ACTIVE"
check "  探针真的交了一份卷" \
  "$(one "SELECT COUNT(*) FROM attempts a JOIN users u ON u.id = a.user_id
            WHERE u.username = 'PROBE01' AND a.mode = 'EXAM' AND a.status <> '进行中';")" "1"

echo
echo "== prod-e2e.sh 第二遍：上次残留了测试章节，探针的英语授权也被撤了 =="
# 两种都是真会遇到的：跑到一半被取消，测试章节留在线上；清理学员时顺手撤了探针的授权
curl -s -o /dev/null -X POST \
  "$BASE/admin/bank/import?subjectCode=biochem&groupId=e2e-probe&label=leftover&orderKey=9999" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/octet-stream' --data-binary "@$SAMPLE"
check "（前提）残留的测试章节在库里" "$(probe_left)" "1"
EN_ID=$(one "SELECT subject_id FROM subjects WHERE code = 'english';")
PROBE_ID=$(one "SELECT id FROM users WHERE username = 'PROBE01';")
curl -s -o /dev/null -X DELETE "$BASE/admin/subjects/$EN_ID/members/$PROBE_ID" -H "Authorization: Bearer $ADMIN_TOKEN"
check "（前提）探针的英语授权撤掉了" \
  "$(one "SELECT COUNT(*) FROM user_subject_grants WHERE user_id = $PROBE_ID AND subject_id = $EN_ID;")" "0"
OUT=$(e2e); RC=$?
show "$OUT"
check "第二遍：退出码 0、一条 FAIL 都没有" "$RC/$(echo "$OUT" | grep -c 'FAIL')" "0/0"
check "  先清掉了残留的测试章节" "$(echo "$OUT" | grep -c '清掉了上次留下的测试章节')" "1"
check "  给探针补开了英语" "$(echo "$OUT" | grep -c '补开了英语')" "1"
check "  测试章节没有留在库里" "$(probe_left)" "0"

echo
echo "== prod-e2e.sh 第三遍：文字解析没配 =="
exec_sql "DELETE FROM ai_settings WHERE purpose = 'TEXT_PARSING';"
check "（前提）文字解析没配了" "$(settings | jq -r '.settings.TEXT_PARSING')" "null"
OUT=$(e2e); RC=$?
show "$OUT"
check "第三遍：判失败" "$RC" "1"
check "  只失败了一条" "$(echo "$OUT" | grep -c 'FAIL')" "1"
check "  就是「文字解析没配」那一条" "$(echo "$OUT" | grep -c 'FAIL 「文字解析 AI」没配')" "1"
check "  没上传、也没调 AI（不白花那几次调用的钱）" \
  "$(probe_left)/$(echo "$OUT" | grep -c 'AI 出答案耗时')" "0/0"
check "  英语那一段照常跑完" "$(echo "$OUT" | grep -c 'OK   能力评估接口可用')" "1"

echo
echo "== prod-e2e.sh 第四遍：模型把作文的 JSON 示例原样抄回来（CR-M11） =="
# 线上实测 #6 作文拿了 0 分、状态却是"已批改"。可能原因之一是模型照抄了提示里用 0 占位的示例。
# 替身的 /echo/ 只对作文这么做，别的调用照常回——一次运行里只让作文这一处出事。
# 文字解析在第三遍被删掉了，先补回来（顺带再验一次"没配才补"）
OUT=$(cfg); RC=$?
check "（前提）文字解析又补回来了" "$RC/$(settings | jq -r '.settings.TEXT_PARSING.model')" "0/Qwen/Qwen3-8B"
curl -s -o /dev/null -X PUT "$BASE/admin/ai/settings/TUTORING" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' -d "{\"baseUrl\":\"http://127.0.0.1:$STUB_PORT/echo/v1\"}"
check "（前提）教学那一档指到了替身的 /echo/" \
  "$(settings | jq -r '.settings.TUTORING.baseUrl')" "http://127.0.0.1:$STUB_PORT/echo/v1"
OUT=$(e2e); RC=$?
show "$OUT"
check "第四遍：判失败" "$RC" "1"
check "  红在作文没批改成，原因写着像是抄了示例" \
  "$(echo "$OUT" | grep -c 'FAIL 作文批改未完成（status=failed）.*原样抄')" "1"
LATEST=$(one "SELECT a.attempt_id FROM attempts a JOIN users u ON u.id = a.user_id
               WHERE u.username = 'PROBE01' AND a.mode = 'EXAM' ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1;")
check "  库里没有记成「已批改的 0 分」（这份卷的作文还是待批改）" \
  "$(one "SELECT r.ai_judged || '/' || COALESCE(r.score, 'null') FROM answer_records r
            JOIN questions q ON q.question_id = r.question_id
           WHERE r.attempt_id = '$LATEST' AND q.question_type = 'essay';")" "0/null"
check "  上传出题那段照常通过（只有作文这一处出事）" "$(echo "$OUT" | grep -c 'OK   4 道全部生成')" "1"
check "  错题分析照常全部成功" "$(echo "$OUT" | grep -c 'OK   错题分析全部成功')" "1"

echo
echo "== 服务还活着 =="
check "跑完之后服务还在" "$(curl -s -o /dev/null -w '%{http_code}' -m 5 "$BASE/health")" "200"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
