#!/usr/bin/env bash
# 放宽 ai_settings.purpose，给「文字解析 AI」腾一档（N7d）。
#
# 为什么单开一个脚本，而不是塞进 rebuild-legacy-schema.sh：那个脚本整体由
# 门闩 n3-legacy-rebuild 守着，线上早就落了闩、开头就 exit 0——加在里面永远跑不到。
# 而且那是出过事故的脚本（第十节），能不动就不动。
#
# **这是个会删表的动作**，所以照第十节的两条规矩来：
#   ① 自带门闩，做过就再也不做，不按"每次重新判断"；
#   ② 判据用 DDL 文本时先剥注释——线上 D1 的 sqlite_master.sql 保留注释，
#      本地 workerd 把注释剥成空行，不剥的话两边判出来的结果不一样。
# 另外这张表存着加密的 API Key，搬丢了线上 AI 全废且直到有人用才发现，
# 所以搬完要核行数，对不上就让部署当场失败。
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../../worker"

MODE="${1:---local}"
D1_NAME=$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')
[ -n "$D1_NAME" ] || { echo "从 wrangler.toml 读不到 database_name"; exit 1; }

FLAGS=""
[ "$MODE" = "--remote" ] && FLAGS="--yes"
d1() { npx wrangler d1 execute "$D1_NAME" "$MODE" $FLAGS "$@"; }
ddl_of() {
  d1 --json --command "SELECT sql FROM sqlite_master WHERE type='table' AND name='$1'" 2>/dev/null \
    | jq -r '.[0].results[0].sql // empty'
}
count_of() {
  d1 --json --command "SELECT COUNT(*) AS c FROM $1" 2>/dev/null | jq -r '.[0].results[0].c // 0'
}
strip_comments() { sed 's/--.*$//'; }

LATCH='n7d-ai-purposes'

HAS_SEED_STATE=$(ddl_of seed_state)
if [ -z "$HAS_SEED_STATE" ]; then
  echo "AI 用途放宽：seed_state 还不存在（全新的库），迁移会直接建出新结构，跳过，零写入。"
  exit 0
fi
DONE=$(d1 --json --command "SELECT COUNT(*) AS c FROM seed_state WHERE name = '$LATCH'" 2>/dev/null \
  | jq -r '.[0].results[0].c // 0')
if [ "${DONE:-0}" != "0" ]; then
  echo "AI 用途放宽：门闩已落（$LATCH），跳过，零写入。"
  exit 0
fi
drop_latch() {
  d1 --command "INSERT OR IGNORE INTO seed_state (name, sha) VALUES ('$LATCH', 'done');" >/dev/null 2>&1
}

DDL=$(ddl_of ai_settings)
if [ -z "$DDL" ]; then
  echo "AI 用途放宽：ai_settings 还不存在，交给迁移去建，落闩。"
  drop_latch; exit 0
fi
# 旧结构的特征：取值清单里只有两档。新结构里这两个词之间隔着 TEXT_PARSING，
# 所以这个串在新表上匹配不到——判据自带终止性，不会反复重建。
if ! printf '%s' "$DDL" | strip_comments | grep -qF "'PARSING', 'TUTORING'"; then
  echo "AI 用途放宽：ai_settings 已是新结构（含 TEXT_PARSING），落闩后不再检查。"
  drop_latch; exit 0
fi

BEFORE=$(count_of ai_settings)
echo "AI 用途放宽：检测到旧取值清单，$BEFORE 行原样搬到新结构（含加密的 API Key）"
d1 --file="$HERE/rebuild/ai_settings_purposes.sql" || { echo "  !! ai_settings 重建失败"; exit 1; }

AFTER=$(count_of ai_settings)
if [ "$AFTER" != "$BEFORE" ]; then
  # 行数对不上就是把 Key 搬丢了。这时候**必须让部署红掉**：
  # 放过去的话线上 AI 全废，而所有读接口照常，只有真去调 AI 才会发现。
  echo "  !! 搬之前 $BEFORE 行，搬之后 $AFTER 行，对不上，停在这里"
  exit 1
fi
NEW_DDL=$(ddl_of ai_settings)
if ! printf '%s' "$NEW_DDL" | strip_comments | grep -qF 'TEXT_PARSING'; then
  echo "  !! 重建完 CHECK 里还是没有 TEXT_PARSING，停在这里"
  exit 1
fi
echo "  ++ 完成，$AFTER 行都在，CHECK 已含 TEXT_PARSING"
drop_latch
