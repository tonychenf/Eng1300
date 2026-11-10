#!/usr/bin/env bash
# 改进阶段 2 第二期·识别实测的服务端（2026-11-09）：配置、建实测、逐张识别（图不留）、存指标、花费与上限。
# 比对算法本身由 node 单测 ocr-metrics.test.mjs 测；页面那一路由 ui-ph2-ocr 测。
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

PORT=8766          # 端口表见 CLAUDE.md
STUB_PORT=8883
BASE="http://127.0.0.1:$PORT/api"
WORK=$(mktemp -d)
PASS=0; FAIL=0
PRICE_IN=1; PRICE_OUT=2       # 元 / 百万 tokens；替身每次回 100 / 50 tokens

check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc";
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
cleanup() {
  [ -n "${SERVER_PID:-}" ] && kill -- "-$SERVER_PID" 2>/dev/null
  [ -n "${STUB_PID:-}" ] && kill "$STUB_PID" 2>/dev/null
  rm -rf "$ROOT_DIR/.wrangler" "$WORK"
  rm -f .dev.vars
}
trap cleanup EXIT
source "$ROOT_DIR/test/lib/d1.sh"
[ -d public ] || { echo "worker/public 不存在。先跑：npm run build --prefix web"; exit 1; }

echo "== 准备：迁移 =="
rm -rf .wrangler
cat > .dev.vars <<'VARS'
JWT_SECRET=test-secret-ph2ocr
SETUP_TOKEN=test-setup-ph2ocr
ENCRYPTION_KEY=test-encryption-key-ph2ocr
VARS
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 || { echo "迁移 $m 失败"; exit 1; }
done

echo "== 启动 AI 替身与服务 =="
node test/ai-stub.mjs "$STUB_PORT" > /tmp/ph2-ocr-bench-stub.log 2>&1 &
STUB_PID=$!
DEV_LOG=/tmp/ph2-ocr-bench-dev.log
setsid npx wrangler dev --local --port $PORT > "$DEV_LOG" 2>&1 < /dev/null &
SERVER_PID=$!
ready=0
for i in $(seq 1 150); do curl -s -m 2 -o /dev/null "$BASE/health" && { ready=1; break; }; sleep 1; done
[ "$ready" = "1" ] || { echo "服务 150 秒没起来："; tail -20 "$DEV_LOG"; exit 1; }

curl -s -o /dev/null -X POST "$BASE/setup" -H 'X-Setup-Token: test-setup-ph2ocr' -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}'
ADMIN=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d '{"username":"admin","password":"adminpass123"}' | jq -r '.token')
PW=$(curl -s -X POST "$BASE/admin/users" -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' -d '{"username":"OCR01","subjects":[]}' | jq -r '.initialPassword')
STU=$(curl -s -X POST "$BASE/auth/login" -H 'Content-Type: application/json' -d "$(jq -n --arg p "$PW" '{username:"OCR01",password:$p}')" | jq -r '.token')
code() { curl -s -o "$WORK/last.json" -w '%{http_code}' -H 'Content-Type: application/json' "$@"; }
A() { curl -s -H "Authorization: Bearer $ADMIN" -H 'Content-Type: application/json' "$@"; }

echo
echo "== 没配「图片解析 AI」时 =="
check "配置接口说清楚先去配" "$(A "$BASE/admin/ai/ocr-bench/config" | jq -r '"\(.provider)/\(.modelsError | test("图片解析 AI"))"')" "null/true"
check "建实测 → 422 ai_not_configured" \
  "$(code -X POST "$BASE/admin/ai/ocr-bench" -H "Authorization: Bearer $ADMIN" -d '{"photos":[{"name":"a.jpg"}],"models":[{"id":"m"}],"sizes":[1600]}')/$(jq -r '.error' "$WORK/last.json")" "422/ai_not_configured"
A -X PUT "$BASE/admin/ai/settings/PARSING" \
  -d "$(jq -n --arg u "http://127.0.0.1:$STUB_PORT/v1" --argjson pi $PRICE_IN --argjson po $PRICE_OUT '{baseUrl:$u,apiKey:"stub-key",model:"stub-ocr:121:0",visionCapable:true,priceInPerM:$pi,priceOutPerM:$po}')" >/dev/null

echo
echo "== 权限 =="
for spec in "GET /admin/ai/ocr-bench/config" "GET /admin/ai/ocr-bench" "POST /admin/ai/ocr-bench" "POST /admin/ai/ocr-bench/x/recognize" "PUT /admin/ai/ocr-bench/x/results/1/metrics" "GET /admin/ai/ocr-bench/x"; do
  set -- $spec
  check "学员令牌调 $1 $2 → 403" "$(code -X "$1" "$BASE$2" -H "Authorization: Bearer $STU" -d '{}')" "403"
done
check "不存在的实测 → 404" "$(code "$BASE/admin/ai/ocr-bench/ocr-nope" -H "Authorization: Bearer $ADMIN")" "404"

echo
echo "== 配置 =="
A "$BASE/admin/ai/ocr-bench/config" > "$WORK/cfg.json"
check "现在用的模型、服务商、单价" "$(jq -r '"\(.provider.model)/\(.provider.host)/\(.provider.priceInPerM)"' "$WORK/cfg.json")" "stub-ocr:121:0/127.0.0.1:$STUB_PORT/$PRICE_IN"
check "服务商的模型清单取回来了（替身列了 3 个）" "$(jq -r '.models | length' "$WORK/cfg.json")" "3"

echo
echo "== 建实测：校验 =="
mk() { code -X POST "$BASE/admin/ai/ocr-bench" -H "Authorization: Bearer $ADMIN" -d "$1"; }
check "没有照片 → 400" "$(mk '{"photos":[],"models":[{"id":"m"}],"sizes":[1600]}')" "400"
check "超过 10 张 → 400" "$(mk "$(jq -nc '{photos:[range(11)|{name:"x.jpg"}],models:[{id:"m"}],sizes:[1600]}')")" "400"
check "尺寸不是 1600/2400 → 400" "$(mk '{"photos":[{"name":"a.jpg"}],"models":[{"id":"m"}],"sizes":[999]}')" "400"
check "单价是负数 → 400" "$(mk '{"photos":[{"name":"a.jpg"}],"models":[{"id":"m","priceInPerM":-1}],"sizes":[1600]}')" "400"
check "建实测 → 201" \
  "$(mk '{"photos":[{"name":"第121页.jpg"},{"name":""}],"models":[{"id":"stub-ocr:121:0"},{"id":"stub-ocr:121:7","priceInPerM":3,"priceOutPerM":4},{"id":"stub-ocr-fail"}],"sizes":[1600,2400],"estimateYuan":0.01}')" "201"
BID=$(jq -r '.id' "$WORK/last.json")
check "不用标页码：照片按第几张编号，没名字的给个名字" "$(jq -c '[.config.photos[] | [.no, .name]]' "$WORK/last.json")" '[[1,"第121页.jpg"],[2,"照片 2"]]'
check "建实测写了审计" "$(one "SELECT COUNT(*) FROM admin_audit WHERE action = 'ocr_bench.create' AND target = '$BID';")" "1"

echo
echo "== 逐张识别：图不留 =="
# 一张真的小 JPEG（1×1），以 data URL 发
IMG="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k="
rec() { code -X POST "$BASE/admin/ai/ocr-bench/$BID/recognize" -H "Authorization: Bearer $ADMIN" -d "$(jq -nc --argjson p "$1" --arg m "$2" --argjson s "$3" --arg i "$4" '{photo:$p,model:$m,size:$s,image:$i}')"; }
check "识别第 1 张（替身原样回第 121 页的转写稿）→ 200，回的是第几张照片" "$(rec 1 'stub-ocr:121:0' 1600 "$IMG")/$(jq -r '.photo' "$WORK/last.json")" "200/1"
R1=$(cat "$WORK/last.json")
check "回来的文字就是第 121 页（第 1 题到第 17 题）" "$(echo "$R1" | jq -r '.text | (test("1\\. It pays") and test("17\\. "))')" "true"
WANT=$(awk -v i=$PRICE_IN -v o=$PRICE_OUT 'BEGIN { printf "%.6f", (100*i + 50*o) / 1e6 }')
check "没在实测里填单价、模型又正好是现配的那个：用配置的单价 → $WANT 元" "$(echo "$R1" | jq -r '.cost * 1e6 | round / 1e6' | xargs printf '%.6f')" "$WANT"
check "实测里填了单价的模型按填的算" "$(rec 1 'stub-ocr:121:7' 1600 "$IMG")/$(jq -r '.cost * 1e6 | round' "$WORK/last.json")" "200/$(( 100*3 + 50*4 ))"
check "服务商报错（不支持图片）：200、结果里记下错误和原因" \
  "$(rec 1 'stub-ocr-fail' 1600 "$IMG")/$(jq -r '.error | test("ai_error") and test("image")' "$WORK/last.json")" "200/true"
check "不在这次实测里的模型 → 400" "$(rec 1 'other-model' 1600 "$IMG")" "400"
check "没有第 3 张照片 → 400" "$(rec 3 'stub-ocr:121:0' 1600 "$IMG")" "400"
check "第 0 张 → 400" "$(rec 0 'stub-ocr:121:0' 1600 "$IMG")" "400"
check "不在这次实测里的尺寸 → 400" "$(rec 1 'stub-ocr:121:0' 1200 "$IMG")" "400"
check "不是图片 → 400" "$(rec 1 'stub-ocr:121:0' 1600 'data:text/plain;base64,aGk=')" "400"
check "库里存了 3 条结果" "$(one "SELECT COUNT(*) FROM ocr_bench_results WHERE bench_id = '$BID';")" "3"
check "图片没进库：结果表里没有任何 base64 图片" "$(one "SELECT COUNT(*) FROM ocr_bench_results WHERE text LIKE '%data:image%' OR error LIKE '%data:image%' OR metrics_json LIKE '%data:image%';")" "0"
check "图片也没进用量日志、审计" \
  "$(one "SELECT (SELECT COUNT(*) FROM ai_usage_logs WHERE error_message LIKE '%/9j/%') + (SELECT COUNT(*) FROM admin_audit WHERE after_json LIKE '%/9j/%');")" "0"
check "识别记账在 ocr_bench 名下、带花费" "$(one "SELECT COUNT(*) || '/' || (SUM(cost_yuan) IS NOT NULL) FROM ai_usage_logs WHERE feature = 'ocr_bench' AND success = 1;")" "2/1"

echo
echo "== 指标存回来、读得出 =="
RID=$(echo "$R1" | jq -r '.resultId')
check "存指标 → 200" "$(code -X PUT "$BASE/admin/ai/ocr-bench/$BID/results/$RID/metrics" -H "Authorization: Bearer $ADMIN" -d '{"metrics":{"accuracy":1,"page":121}}')" "200"
check "存到别的实测名下 → 404" "$(code -X PUT "$BASE/admin/ai/ocr-bench/ocr-x/results/$RID/metrics" -H "Authorization: Bearer $ADMIN" -d '{"metrics":{"accuracy":1}}')" "404"
A "$BASE/admin/ai/ocr-bench/$BID" > "$WORK/run.json"
check "读回实测：3 条结果都是第 1 张照片，存过的指标带着" "$(jq -r '"\(.results | length)/\([.results[] | select(.photo == 1)] | length)/\([.results[] | select(.metrics.accuracy == 1)] | length)"' "$WORK/run.json")" "3/3/1"
check "列表里有这次实测" "$(A "$BASE/admin/ai/ocr-bench" | jq -r --arg b "$BID" '[.runs[] | select(.id == $b)] | length')" "1"

echo
echo "== 以前标页码的实测（2026-11-09 那一版）照样读得出 =="
exec_sql "INSERT INTO ocr_bench_runs (id, created_by, config_json) VALUES ('ocr-old', 1, '{\"pages\":[121],\"models\":[{\"id\":\"m\"}],\"sizes\":[1600]}');
INSERT INTO ocr_bench_results (bench_id, page, model, size, text) VALUES ('ocr-old', 121, 'm', 1600, 'x');" >/dev/null
check "旧实测的结果带原书页码、不带第几张" "$(A "$BASE/admin/ai/ocr-bench/ocr-old" | jq -r '.results[0] | "\(.page)/\(has("photo"))"')" "121/false"

echo
echo "== 每月上限：建实测要明说继续 =="
A -X PUT "$BASE/admin/ai/budget" -d '{"yuan":0.0001}' >/dev/null
check "到了上限，不说继续 → 409 over_budget" "$(mk '{"photos":[{"name":"a.jpg"}],"models":[{"id":"stub-ocr:121:0"}],"sizes":[1600]}')/$(jq -r '.error' "$WORK/last.json")" "409/over_budget"
check "说继续 → 201，审计记下是超额继续的" \
  "$(mk '{"photos":[{"name":"a.jpg"}],"models":[{"id":"stub-ocr:121:0"}],"sizes":[1600],"confirmOverBudget":true}')/$(one "SELECT COUNT(*) FROM admin_audit WHERE action = 'ocr_bench.create_over_budget';")" "201/1"
A -X PUT "$BASE/admin/ai/budget" -d '{"yuan":null}' >/dev/null

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
exit $([ "$FAIL" = 0 ] && echo 0 || echo 1)
