#!/usr/bin/env bash
# N3：把 N0/N1 时期建好的旧表换成能力包需要的结构。
#
# 为什么不写成普通迁移：迁移全是 CREATE TABLE IF NOT EXISTS，对**已经存在**的表
# 一行都不会改。新库照着改好的 0002_bank.sql 一次建对，而线上那个库是 N0 时按旧结构
# 建的，光改 0002 对它毫无作用——本地测试（每次都是新库）全绿，线上还是老结构。
# 这是个不报错的分叉，所以要有这么一道显式的检测。
#
# 为什么要清数据：questions 的 question_type 上有写死三种英语题型的 CHECK，
# SQLite 去不掉 CHECK，只能重建表；而 D1 既不认 defer_foreign_keys 也不认
# legacy_alter_table，DROP 一张有子表引用的父表一定触发外键约束失败
# （试过 rename-then-create，会留下"新表建好了、老表没删掉"的半完成状态，比直接
# 失败更糟）。所以只能先把引用它的行清掉。题库和作答记录都是可重新生成的：
# 题库由流水线按内容指纹重新导入，作答记录是 T001–T010 那些合成账号做的。
#
# 为什么要排在迁移**之前**：0002 里新加的 idx_questions_subject 建在 subject_id 上，
# 旧表没这一列，迁移会当场断在那句。顺序是 重建 → 迁移 → 部署 → 导题库。
#
# **这个脚本清过一次线上题库，读完下面两段再改它。**
#
# 事故（2026-09-23，部署 #44）：第一版按「DDL 文本里有没有旧约束」判断新旧，
# 而我在 0002_bank.sql 的注释里抄了那条旧约束的原文。线上 D1 的 sqlite_master.sql
# **保留注释**，于是新表被当成旧表，每次部署都重清一遍 questions。
# 本地 workerd 把注释剥成空行，所以 n3-rebuild.sh 28/0 全绿，测不出来。
# #43 没暴露是因为那轮种子指纹变了会重新导入，正好把坑填上；#44 指纹没变、
# 导入跳过，题库就空了。
#
# 由此定下三条，改这个脚本时不要拆掉：
#   ① **上门闩**。会删数据的动作只能做一次，门闩记在 seed_state，
#      不能每次部署重新判断——判断逻辑再准也只是"这次没错"。
#   ② **比对前先剥注释**。注释会进 sqlite_master，特征串撞上注释就是误判。
#   ③ **删了题库就让种子指纹失效**。这条是当时缺的不变量：有它的话，误判的后果
#      只是多导一次题库（浪费额度），而不是留下一个空题库还一路绿到验证步骤。
#
# 用法：rebuild-legacy-schema.sh --local|--remote
set -uo pipefail

MODE="${1:-}"
case "$MODE" in
  --local|--remote) ;;
  *) echo "用法：$0 --local|--remote"; exit 2 ;;
esac

HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../../worker"

D1_NAME="${D1_NAME:-$(grep -E '^database_name' wrangler.toml | head -1 | sed -E 's/.*"([^"]*)".*/\1/')}"
[ -n "$D1_NAME" ] || { echo "读不到 database_name"; exit 1; }

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
# 比对前先把 SQL 行注释剥掉：sqlite_master 存的是建表语句原文，注释也在里面，
# 特征串撞上注释就是误判（见抬头的事故记录）。
strip_comments() { sed 's/--.*$//'; }

is_legacy() {   # 表名 特征串
  local ddl; ddl=$(ddl_of "$1")
  [ -n "$ddl" ] && printf '%s' "$ddl" | strip_comments | grep -qF "$2"
}

# 门闩。做过就再也不做——这是个会删数据的动作，不能每次部署重新判断一次。
LATCH='n3-legacy-rebuild'
HAS_SEED_STATE=$(ddl_of seed_state)
if [ -z "$HAS_SEED_STATE" ]; then
  # 迁移还没跑过，是个全新的库，天生就是新结构，没有什么要重建的。
  echo "旧结构重建：seed_state 还不存在（全新的库），跳过，零写入。"
  exit 0
fi
DONE=$(d1 --json --command "SELECT COUNT(*) AS c FROM seed_state WHERE name = '$LATCH'" 2>/dev/null \
  | jq -r '.[0].results[0].c // 0')
if [ "${DONE:-0}" != "0" ]; then
  echo "旧结构重建：门闩已落（$LATCH），跳过，零写入。"
  exit 0
fi

LEGACY_Q=0; LEGACY_K=0; LEGACY_A=0
is_legacy questions        'CHECK (question_type IN'   && LEGACY_Q=1
is_legacy knowledge_points 'name TEXT NOT NULL UNIQUE' && LEGACY_K=1
is_legacy ai_settings      'purpose TEXT PRIMARY KEY'  && LEGACY_A=1

drop_latch() {
  d1 --command "INSERT OR IGNORE INTO seed_state (name, sha) VALUES ('$LATCH', 'done');" >/dev/null 2>&1
}

if [ $((LEGACY_Q + LEGACY_K + LEGACY_A)) -eq 0 ]; then
  echo "旧结构重建：三张表都已是 N3 结构，落门闩后不再检查。"
  drop_latch
  exit 0
fi

echo "旧结构重建：检测到旧表 questions=$LEGACY_Q knowledge_points=$LEGACY_K ai_settings=$LEGACY_A"

# ai_settings 没有子表，可以原地搬数据保住那两行（里面是加密后的 API Key，
# 搬丢了线上 AI 全废，而且直到有人用才会发现）。
if [ "$LEGACY_A" = "1" ]; then
  echo "  ++ ai_settings：$(count_of ai_settings) 行原样搬到新结构（subject_id=0 表示全局）"
  d1 --file="$HERE/rebuild/ai_settings.sql" || { echo "  !! ai_settings 重建失败"; exit 1; }
  echo "  ++ ai_settings 完成，现有 $(count_of ai_settings) 行"
fi

if [ $((LEGACY_Q + LEGACY_K)) -eq 0 ]; then
  echo "旧结构重建：完成。"
  exit 0
fi

# 引用这两张表的行必须先清掉，否则 DROP 触发外键约束失败。
# 删除顺序是从叶子往根走：attempt_questions 还引用 attempts。
echo "  -- 将要清空（都是可重新生成的数据）："
for t in answer_records attempt_questions wrong_items question_knowledge_points user_knowledge_mastery attempts; do
  echo "       $t: $(count_of "$t") 行"
done
d1 --command "
  DELETE FROM answer_records;
  DELETE FROM attempt_questions;
  DELETE FROM wrong_items;
  DELETE FROM question_knowledge_points;
  DELETE FROM user_knowledge_mastery;
  DELETE FROM attempts;
" || { echo "  !! 清空子表失败"; exit 1; }

[ "$LEGACY_Q" = "1" ] && { echo "  ++ 拆掉旧的 questions（$(count_of questions) 行，题库由流水线按内容指纹重新导入）"; d1 --command "DROP TABLE questions;" || exit 1; }
[ "$LEGACY_K" = "1" ] && { echo "  ++ 拆掉旧的 knowledge_points（$(count_of knowledge_points) 行，随题库一起重新导入）"; d1 --command "DROP TABLE knowledge_points;" || exit 1; }

# 题库拆掉了，种子的内容指纹就必须一起作废，否则 seed-if-changed.sh 会看着
# "指纹没变"把导入整个跳过，留下一个空题库——而在它之后的每一步都不会报错。
# 这条不变量当时缺了，就是 #44 那次空题库的直接原因。
echo "  ++ 作废题库种子指纹，强制下一步重新导入"
d1 --command "DELETE FROM seed_state WHERE name GLOB '[0-9][0-9][0-9]-*.sql';" || exit 1

drop_latch
# 不在这里重建表：紧接着跑的迁移会按 0002_bank.sql 的新结构建出来，
# 两处各写一份 DDL 迟早对不上，而对不上是不会报错的。
echo "旧结构重建：完成，门闩已落。表由随后的迁移按新结构重建，题库由种子重新导入。"
