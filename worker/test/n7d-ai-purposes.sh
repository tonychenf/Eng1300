#!/usr/bin/env bash
# ai_settings.purpose 放宽一档的重建脚本测试（N7d）。不起服务。
#
# 和 n3-rebuild 同一个道理：这个脚本只在**线上那个旧库**上真正动手，
# 本地每次都是新库、天生就是新结构，正常回归永远走不到它的主路径。
# 所以这里先把表退回旧的取值清单，再让脚本去处理。
#
# 重点守两件事：
#   ① 那两行里是加密后的 API Key，搬丢了线上 AI 全废，而且直到有人用才会发现；
#   ② 这是个会删表的动作，必须落门闩——不落的话每次部署都重建一次，
#      而重建窗口里任何一次失败都会把 Key 带走（第十节那场事故的形状）。
set -uo pipefail
cd "$(dirname "$0")/.."
ROOT_DIR="$(pwd)"
D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
SCRIPT="$ROOT_DIR/../scripts/ci/rebuild-ai-purposes.sh"

PASS=0; FAIL=0
check() {
  local desc="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then PASS=$((PASS+1)); echo "  OK   $desc"
  else FAIL=$((FAIL+1)); echo "  FAIL $desc (期望 $want, 实际 $got)"; fi
}
sql()  { npx wrangler d1 execute "$D1_NAME" --local --json --command "$1" 2>/dev/null; }
one()  { sql "$1" | jq -r '.[0].results[0] | to_entries[0].value // empty'; }
ddl()  { sql "SELECT sql FROM sqlite_master WHERE type='table' AND name='$1'" | jq -r '.[0].results[0].sql // empty'; }
run()  { bash "$SCRIPT" --local 2>&1; }

cleanup() { rm -rf "$ROOT_DIR/.wrangler"; }
trap cleanup EXIT
rm -rf .wrangler

echo "== 全新的库：什么都不做 =="
OUT=$(run)
check "seed_state 不存在时跳过" "$(echo "$OUT" | grep -c '全新的库')" "1"

echo
echo "== 迁移建出来的新库，天生就带 TEXT_PARSING =="
for m in migrations/*.sql; do
  npx wrangler d1 execute "$D1_NAME" --local --file="$m" >/dev/null 2>&1 \
    || { echo "迁移 $m 失败"; exit 1; }
done
check "新库的 CHECK 里有 TEXT_PARSING" \
  "$(ddl ai_settings | grep -c TEXT_PARSING)" "1"
OUT=$(run)
check "已是新结构时不重建" "$(echo "$OUT" | grep -c '已是新结构')" "1"
check "并且落了门闩" "$(one "SELECT COUNT(*) FROM seed_state WHERE name='n7d-ai-purposes';")" "1"
OUT=$(run)
check "第二次跑直接被门闩挡住" "$(echo "$OUT" | grep -c '门闩已落')" "1"

echo
echo "== 把表退回旧结构，模拟线上那个库 =="
npx wrangler d1 execute "$D1_NAME" --local --command \
  "DELETE FROM seed_state WHERE name='n7d-ai-purposes';" >/dev/null 2>&1
npx wrangler d1 execute "$D1_NAME" --local --command "DROP TABLE ai_settings;" >/dev/null 2>&1
npx wrangler d1 execute "$D1_NAME" --local --command \
  "CREATE TABLE ai_settings (
     purpose TEXT NOT NULL CHECK (purpose IN ('PARSING', 'TUTORING')),
     subject_id INTEGER NOT NULL DEFAULT 0, base_url TEXT, api_key_encrypted TEXT,
     model TEXT, protocol TEXT NOT NULL DEFAULT 'openai',
     vision_capable INTEGER NOT NULL DEFAULT 0, updated_at TEXT,
     PRIMARY KEY (purpose, subject_id));" >/dev/null 2>&1
# 两行真数据，api_key_encrypted 放一个可辨认的串：搬完要逐字还在
npx wrangler d1 execute "$D1_NAME" --local --command \
  "INSERT INTO ai_settings (purpose, subject_id, base_url, api_key_encrypted, model, vision_capable, updated_at)
   VALUES ('PARSING', 0, 'https://img.example/v1', 'ENC-KEY-IMG-763', 'vision-m', 1, '2026-01-01'),
          ('TUTORING', 0, 'https://tut.example/v1', 'ENC-KEY-TUT-118', 'tutor-m', 0, '2026-01-02');" >/dev/null 2>&1
check "旧结构就位（CHECK 里没有 TEXT_PARSING）" "$(ddl ai_settings | grep -c TEXT_PARSING)" "0"
check "旧表里有 2 行" "$(one 'SELECT COUNT(*) FROM ai_settings;')" "2"
# 先证明旧结构真的插不进新档——否则下面"重建之后能插"就成了恒真
BEFORE_INSERT=$(npx wrangler d1 execute "$D1_NAME" --local --command \
  "INSERT INTO ai_settings (purpose, subject_id, base_url) VALUES ('TEXT_PARSING', 0, 'x');" 2>&1 \
  | grep -ci "constraint\|CHECK" || true)
check "旧结构下新档确实插不进去（否则这套测试没意义）" \
  "$([ "${BEFORE_INSERT:-0}" -ge 1 ] && echo 插不进 || echo 居然插进去了)" "插不进"

echo
echo "== 重建：放宽取值，一行不少 =="
OUT=$(run)
check "认出了旧的取值清单" "$(echo "$OUT" | grep -c '检测到旧取值清单')" "1"
check "重建后 CHECK 里有 TEXT_PARSING" "$(ddl ai_settings | grep -c TEXT_PARSING)" "1"
check "两行都还在" "$(one 'SELECT COUNT(*) FROM ai_settings;')" "2"
# 逐字核 Key：这是整件事的要害，行数对得上但内容被冲掉一样是灾难
check "图片解析那行的 Key 原样还在" \
  "$(one "SELECT api_key_encrypted FROM ai_settings WHERE purpose='PARSING';")" "ENC-KEY-IMG-763"
check "教学那行的 Key 原样还在" \
  "$(one "SELECT api_key_encrypted FROM ai_settings WHERE purpose='TUTORING';")" "ENC-KEY-TUT-118"
check "其余字段也没丢（vision_capable）" \
  "$(one "SELECT vision_capable FROM ai_settings WHERE purpose='PARSING';")" "1"
check "主键还是 (purpose, subject_id)" "$(ddl ai_settings | grep -c 'PRIMARY KEY (purpose, subject_id)')" "1"
check "重建之后新档插得进去了" \
  "$(npx wrangler d1 execute "$D1_NAME" --local --command \
      "INSERT INTO ai_settings (purpose, subject_id, base_url) VALUES ('TEXT_PARSING', 0, 'ok');" >/dev/null 2>&1 \
      && echo 插进去了 || echo 还是插不进)" "插进去了"
check "并且落了门闩" "$(one "SELECT COUNT(*) FROM seed_state WHERE name='n7d-ai-purposes';")" "1"

echo
echo "== 门闩必须真的挡住（这是会删表的动作）=="
# 没有门闩的话每次部署都重建一次；重建窗口里任何一次失败都把 Key 带走。
# 这里再插一行做标记，跑完之后它必须还在——说明脚本根本没动过这张表。
npx wrangler d1 execute "$D1_NAME" --local --command \
  "UPDATE ai_settings SET api_key_encrypted='MARK-AFTER-LATCH' WHERE purpose='PARSING';" >/dev/null 2>&1
OUT=$(run)
check "门闩挡住了" "$(echo "$OUT" | grep -c '门闩已落')" "1"
check "表没被再动一次" \
  "$(one "SELECT api_key_encrypted FROM ai_settings WHERE purpose='PARSING';")" "MARK-AFTER-LATCH"

echo
echo "== 小结: $PASS 通过, $FAIL 失败 =="
[ "$FAIL" -eq 0 ]
