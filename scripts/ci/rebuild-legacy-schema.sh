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
is_legacy() {   # 表名 特征串
  local ddl; ddl=$(ddl_of "$1")
  [ -n "$ddl" ] && printf '%s' "$ddl" | grep -qF "$2"
}

LEGACY_Q=0; LEGACY_K=0; LEGACY_A=0
is_legacy questions        'CHECK (question_type IN'   && LEGACY_Q=1
is_legacy knowledge_points 'name TEXT NOT NULL UNIQUE' && LEGACY_K=1
is_legacy ai_settings      'purpose TEXT PRIMARY KEY'  && LEGACY_A=1

if [ $((LEGACY_Q + LEGACY_K + LEGACY_A)) -eq 0 ]; then
  echo "旧结构重建：三张表都已是 N3 结构（或还没建），跳过，零写入。"
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

# 不在这里重建表：紧接着跑的迁移会按 0002_bank.sql 的新结构建出来，
# 两处各写一份 DDL 迟早对不上，而对不上是不会报错的。
echo "旧结构重建：完成。表由随后的迁移按新结构重建，题库由种子重新导入。"
